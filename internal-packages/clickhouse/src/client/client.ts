import {
  type ClickHouseClient,
  ClickHouseError,
  ClickHouseLogLevel,
  type ClickHouseSettings,
  createClient,
} from "@clickhouse/client";
import { recordSpanError, Span, startSpan, trace, Tracer } from "@internal/tracing";
import { flattenAttributes, tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { InsertError, QueryError } from "./errors.js";
import type {
  ClickhouseInsertFunction,
  ClickhouseQueryBuilderFunction,
  ClickhouseQueryFunction,
  ClickhouseReader,
  ClickhouseWriter,
} from "./types.js";
import { generateErrorMessage } from "zod-error";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";
import { ClickhouseQueryBuilder } from "./queryBuilder.js";
import { randomUUID } from "node:crypto";

export type ClickhouseConfig = {
  name: string;
  url: string;
  tracer?: Tracer;
  keepAlive?: {
    enabled?: boolean;
    idleSocketTtl?: number;
  };
  httpAgent?: HttpAgent | HttpsAgent;
  clickhouseSettings?: ClickHouseSettings;
  logger?: Logger;
  maxOpenConnections?: number;
  logLevel?: LogLevel;
  compression?: {
    request?: boolean;
    response?: boolean;
  };
};

export class ClickhouseClient implements ClickhouseReader, ClickhouseWriter {
  public readonly client: ClickHouseClient;
  private readonly tracer: Tracer;
  private readonly name: string;
  private readonly logger: Logger;

  constructor(config: ClickhouseConfig) {
    this.name = config.name;
    this.logger = config.logger ?? new Logger("ClickhouseClient", config.logLevel ?? "info");

    this.client = createClient({
      url: config.url,
      keep_alive: config.keepAlive,
      http_agent: config.httpAgent,
      compression: config.compression,
      max_open_connections: config.maxOpenConnections,
      clickhouse_settings: {
        ...config.clickhouseSettings,
        output_format_json_quote_64bit_integers: 0,
        output_format_json_quote_64bit_floats: 0,
        cancel_http_readonly_queries_on_client_close: 1,
      },
      log: {
        level: convertLogLevelToClickhouseLogLevel(config.logLevel),
      },
    });

    this.tracer = config.tracer ?? trace.getTracer("@internal/clickhouse");
  }

  public async close() {
    await this.client.close();
  }

  public query<TIn extends z.ZodSchema<any>, TOut extends z.ZodSchema<any>>(req: {
    /**
     * The name of the operation.
     * This will be used to identify the operation in the span.
     */
    name: string;
    /**
     * The SQL query to run.
     * Use {paramName: Type} to define parameters
     * Example: `SELECT * FROM table WHERE id = {id: String}`
     */
    query: string;
    /**
     * The schema of the parameters
     * Example: z.object({ id: z.string() })
     */
    params?: TIn;
    /**
     * The schema of the output of each row
     * Example: z.object({ id: z.string() })
     */
    schema: TOut;
    /**
     * The settings to use for the query.
     * These will be merged with the default settings.
     */
    settings?: ClickHouseSettings;
  }): ClickhouseQueryFunction<z.input<TIn>, z.output<TOut>> {
    return async (params, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "query", async (span) => {
        this.logger.debug("Querying clickhouse", {
          name: req.name,
          query: req.query.replace(/\s+/g, " "),
          params,
          settings: req.settings,
          attributes: options?.attributes,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        const validParams = req.params?.safeParse(params);

        if (validParams?.error) {
          recordSpanError(span, validParams.error);

          this.logger.error("Error parsing query params", {
            name: req.name,
            error: validParams.error,
            query: req.query,
            params,
            queryId,
          });

          return [
            new QueryError(`Bad params: ${generateErrorMessage(validParams.error.issues)}`, {
              query: req.query,
            }),
            null,
          ];
        }

        let unparsedRows: Array<TOut> = [];

        const [clickhouseError, res] = await tryCatch(
          this.client.query({
            query: req.query,
            query_params: validParams?.data,
            format: "JSONEachRow",
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error querying clickhouse", {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          });

          recordClickhouseError(span, clickhouseError);

          return [
            new QueryError(`Unable to query clickhouse: ${clickhouseError.message}`, {
              query: req.query,
            }),
            null,
          ];
        }

        unparsedRows = await res.json();

        span.setAttributes({
          "clickhouse.query_id": res.query_id,
          ...flattenAttributes(res.response_headers, "clickhouse.response_headers"),
        });

        const summaryHeader = res.response_headers["x-clickhouse-summary"];

        if (typeof summaryHeader === "string") {
          span.setAttributes({
            ...flattenAttributes(JSON.parse(summaryHeader), "clickhouse.summary"),
          });
        }

        const parsed = z.array(req.schema).safeParse(unparsedRows);

        if (parsed.error) {
          this.logger.error("Error parsing clickhouse query result", {
            name: req.name,
            error: parsed.error,
            query: req.query,
            params,
            queryId,
          });

          const queryError = new QueryError(generateErrorMessage(parsed.error.issues), {
            query: req.query,
          });

          recordSpanError(span, queryError);

          return [queryError, null];
        }

        span.setAttributes({
          "clickhouse.rows": unparsedRows.length,
        });

        return [null, parsed.data];
      });
    };
  }

  public queryBuilder<TOut extends z.ZodSchema<any>>(req: {
    name: string;
    baseQuery: string;
    schema: TOut;
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFunction<z.input<TOut>> {
    return (chSettings) =>
      new ClickhouseQueryBuilder(req.name, req.baseQuery, this, req.schema, {
        ...req.settings,
        ...chSettings?.settings,
      });
  }

  public insert<TSchema extends z.ZodSchema<any>>(req: {
    name: string;
    table: string;
    schema: TSchema;
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<z.input<TSchema>> {
    return async (events, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "insert", async (span) => {
        this.logger.debug("Inserting into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          events: Array.isArray(events) ? events.length : 1,
          settings: req.settings,
          attributes: options?.attributes,
          options,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.tableName": req.table,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        let validatedEvents: z.output<TSchema> | z.output<TSchema>[] | undefined = undefined;

        const v = Array.isArray(events)
          ? req.schema.array().safeParse(events)
          : req.schema.safeParse(events);

        if (!v.success) {
          this.logger.error("Error validating insert events", {
            name: req.name,
            table: req.table,
            error: v.error,
          });

          const error = new InsertError(generateErrorMessage(v.error.issues));

          recordSpanError(span, error);

          return [error, null];
        }

        validatedEvents = v.data;

        const [clickhouseError, result] = await tryCatch(
          this.client.insert({
            table: req.table,
            format: "JSONEachRow",
            values: Array.isArray(validatedEvents) ? validatedEvents : [validatedEvents],
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error inserting into clickhouse", {
            name: req.name,
            error: clickhouseError,
            table: req.table,
          });

          recordClickhouseError(span, clickhouseError);

          return [new InsertError(clickhouseError.message), null];
        }

        this.logger.debug("Inserted into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          result,
          queryId,
        });

        span.setAttributes({
          "clickhouse.query_id": result.query_id,
          "clickhouse.executed": result.executed,
          "clickhouse.summary.read_rows": result.summary?.read_rows,
          "clickhouse.summary.read_bytes": result.summary?.read_bytes,
          "clickhouse.summary.written_rows": result.summary?.written_rows,
          "clickhouse.summary.written_bytes": result.summary?.written_bytes,
          "clickhouse.summary.total_rows_to_read": result.summary?.total_rows_to_read,
          "clickhouse.summary.result_rows": result.summary?.result_rows,
          "clickhouse.summary.result_bytes": result.summary?.result_bytes,
          "clickhouse.summary.elapsed_ns": result.summary?.elapsed_ns,
        });

        return [null, result];
      });
    };
  }
}

function recordClickhouseError(span: Span, error: Error) {
  if (error instanceof ClickHouseError) {
    span.setAttributes({
      "clickhouse.error.code": error.code,
      "clickhouse.error.message": error.message,
      "clickhouse.error.type": error.type,
    });
    recordSpanError(span, error);
  } else {
    recordSpanError(span, error);
  }
}

function convertLogLevelToClickhouseLogLevel(logLevel?: LogLevel) {
  if (!logLevel) {
    return ClickHouseLogLevel.INFO;
  }

  switch (logLevel) {
    case "debug":
      return ClickHouseLogLevel.DEBUG;
    case "info":
      return ClickHouseLogLevel.INFO;
    case "warn":
      return ClickHouseLogLevel.WARN;
    case "error":
      return ClickHouseLogLevel.ERROR;
    default:
      return ClickHouseLogLevel.INFO;
  }
}
