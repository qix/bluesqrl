import { Command, Flags } from "@oclif/core";

import { Kafka, Producer } from "kafkajs";
import { invariant } from "../../util/invariant";
import { DeferredPromise } from "../../util/DeferredPromise";
import * as fs from "fs";
import * as sqrlJsonPath from "sqrl-jsonpath";
import * as sqrlLoadFunctions from "sqrl-load-functions";
import * as sqrlRedisFunctions from "sqrl-redis-functions";
import * as sqrlTextFunctions from "sqrl-text-functions";
import { join as joinPath } from "path";
import {
  Execution,
  AT,
  createInstance,
  compileFromFilesystem,
  VirtualFilesystem,
  createSimpleContext,
  SimpleManipulator,
  Context,
} from "sqrl";
import {
  createKafkaClient,
  kafkaConsumerFlags,
  runConsumer,
} from "../../kafka/runConsumer";
import { Pacer } from "../../util/Pacer";

class Manipulator extends SimpleManipulator {
  private messages: {
    [topic: string]: Buffer[];
  } = {};
  private readonly = false;

  constructor(private producer: Producer) {
    super();
  }
  kafkaWrite(topic: string, value: string | Buffer) {
    invariant(!this.readonly, "Manipulator is in readonly mode");
    this.messages[topic] = this.messages[topic] || [];
    if (typeof value === "string") {
      value = Buffer.from(value, "utf-8");
    }
    this.messages[topic].push(value);
  }

  private async kafkaProduce() {
    const transaction = await this.producer.transaction();

    try {
      await transaction.sendBatch({
        topicMessages: Object.entries(this.messages).map(([topic, values]) => {
          return {
            topic,
            messages: values.map((value) => ({ value })),
          };
        }),
      });
      await transaction.commit();
    } catch (e) {
      invariant(e instanceof Error, "Expected error");
      console.error("Error during transaction: " + e.toString());
      await transaction.abort();
    }
  }
  async mutate(ctx: Context) {
    this.readonly = true;
    await Promise.all([super.mutate(ctx), this.kafkaProduce()]);
  }
}

async function readDirContents(
  path: string
): Promise<{ [name: string]: string }> {
  const result: { [name: string]: string } = {};
  const files = await fs.promises.readdir(path);

  await Promise.all(
    files.map(async (file) => {
      const fullPath = joinPath(path, file);
      const contents = await fs.promises.readFile(fullPath, "utf-8");
      result[file] = contents;
    })
  );
  return result;
}

export default class ProcessFeed extends Command {
  static description = "Read the kafka feed and process it with SQRL";

  static flags = kafkaConsumerFlags("process-feed");

  private kafka: Kafka | null = null;

  async run(): Promise<void> {
    const { flags } = await this.parse(ProcessFeed);

    const instance = createInstance({
      config: {
        "state.allow-in-memory": true,
        "sqrl-text-functions": {
          builtinRegExp: true,
        },
      },
    });
    await instance.importFromPackage("sqrl-jsonpath", sqrlJsonPath);
    await instance.importFromPackage(
      "sqrl-redis-functions",
      sqrlRedisFunctions
    );
    await instance.importFromPackage("sqrl-text-functions", sqrlTextFunctions);
    await instance.importFromPackage("sqrl-load-functions", sqrlLoadFunctions);

    instance.registerStatement(
      "SqrlWriteStatements",
      async function bigqueryWrite(
        state: Execution,
        table: string,
        payload: any
      ) {
        invariant(
          state.manipulator instanceof Manipulator,
          "Expected custom Manipulator"
        );
        state.manipulator.kafkaWrite("bigQuery", JSON.stringify(payload));
      },
      {
        allowNull: true,
        args: [AT.state, AT.constant.string, AT.any],
        argstring: "table name, payload",
        docstring: "Write a row to bigquery",
      }
    );

    // @todo: If this is moved
    const files = await readDirContents(joinPath(__dirname, "../../sqrl"));
    const vfs = new VirtualFilesystem(files);
    const { executable } = await compileFromFilesystem(instance, vfs);

    this.kafka = createKafkaClient(flags);

    const producer = this.kafka.producer({
      transactionalId: "feed-sqrl-producer",
      maxInFlightRequests: 1,
      idempotent: true,
    });
    await producer.connect();

    let totalProcessed = 0;
    const pacer = new Pacer({
      intervalMs: 15000,
    });

    await runConsumer({
      kafka: this.kafka,
      topic: "inputEvents",
      restart: flags.resart,
      async eachMessage({ message }) {
        invariant(message.value);
        const data = JSON.parse(message.value.toString("utf-8"));

        const ctx = createSimpleContext();
        const execution = await executable.execute(ctx, {
          manipulator: new Manipulator(producer),
          inputs: {
            EventName: data.eventName,
            EventPayload: data.payload,
          },
        });

        await execution.fetchFeature("SqrlExecutionComplete");
        await execution.manipulator.mutate(ctx);

        totalProcessed += 1;
        if (pacer.test()) {
          console.log("Processed " + totalProcessed + " messages");
        }
      },
    });

    await producer.disconnect();
    // @todo: Close things
  }
}
