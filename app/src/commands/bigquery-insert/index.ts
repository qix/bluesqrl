import { Command, Flags } from "@oclif/core";
import { BigQuery } from "@google-cloud/bigquery";
import { Kafka } from "kafkajs";
import {
  createKafkaClient,
  kafkaConsumerFlags,
  runConsumer,
} from "../../kafka/runConsumer";
import { Pacer } from "../../util/Pacer";

export default class BigQueryInsert extends Command {
  static description = "Stream inserts into BigQuery";

  static flags = kafkaConsumerFlags("bigquery-insert");

  async run(): Promise<void> {
    const { flags } = await this.parse(BigQueryInsert);
    const bigquery = new BigQuery();

    const kafka = createKafkaClient(flags);

    const datasetId = "bluesky";
    const tableId = "events";

    // Retrieve current table metadata
    const table = bigquery.dataset(datasetId).table(tableId);
    const [metadata] = await table.getMetadata();

    const [result] = await table.setMetadata({
      ...metadata,
      schema: {
        ...metadata.schema,
        fields: [
          { name: "EventName", type: "STRING" },
          { name: "EventPayload", type: "JSON" },
          { name: "UserText", type: "STRING" },
          { name: "PostCountByAuthorHour", type: "INT64" },

          // NUMERIC, BIGNUMERIC, FLOAT64, INT64, BOOL,
          // STRING, BYTES, TIMESTAMP, DATE, TIME, DATETIME, GEOGRAPHY
          // JSON, STRUCT
        ],
      },
    });

    let totalProcessed = 0;
    const pacer = new Pacer({
      intervalMs: 15000,
    });
    totalProcessed += 1;
    await runConsumer({
      kafka: kafka,
      topic: "bigQuery",
      restart: flags.resart,
      async eachBatch({ batch }) {
        const inserts = batch.messages.map((message) => {
          if (message.value === null) {
            console.error(
              "Invalid message in kafka: " +
                `${batch.topic}:${batch.partition}:${message.offset}`
            );
            return;
          }
          const parsed = JSON.parse(message.value.toString());

          return {
            ...parsed,
            EventPayload: JSON.stringify(parsed.EventPayload),
          };
        });

        await bigquery.dataset("bluesky").table("events").insert(inserts);

        totalProcessed += batch.messages.length;
        if (pacer.test()) {
          console.log("Processed " + totalProcessed + " messages");
        }
      },
    });
  }
}
