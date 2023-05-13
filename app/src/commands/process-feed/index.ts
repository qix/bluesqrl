import { Command, Flags } from "@oclif/core";

import { Kafka } from "kafkajs";
import { invariant } from "../../util/invariant";
import { DeferredPromise } from "../../util/DeferredPromise";

import * as sqrlJsonPath from "sqrl-jsonpath";
import * as sqrlLoadFunctions from "sqrl-load-functions";
import * as sqrlRedisFunctions from "sqrl-redis-functions";
import * as sqrlTextFunctions from "sqrl-text-functions";
import {
  Execution,
  AT,
  WhenCause,
  FeatureMap,
  createInstance,
  compileFromFilesystem,
  VirtualFilesystem,
  createSimpleContext,
  SimpleManipulator,
} from "sqrl";

// @todo: Get this from kafkajs?
const FROM_EARLIEST = -2;

export default class ProcessFeed extends Command {
  static description = "Read the kafka feed and process it with SQRL";

  static flags = {
    kafka: Flags.string({
      description: "Kafka server",
      required: true,
      default: "localhost:9092",
    }),
  };

  private kafka: Kafka | null = null;

  async run(): Promise<void> {
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

    const fs = new VirtualFilesystem({
      "main.sqrl": `
        LET EventName := input();
        LET EventPayload := input();
        LET Author := jsonValue(EventPayload, "$.author");
        LET CountByAuthor := count(BY Author);
    `,
    });
    const { executable } = await compileFromFilesystem(instance, fs);

    const { flags } = await this.parse(ProcessFeed);
    const interrupted = new DeferredPromise<void>();

    process.on("SIGINT", function () {
      console.log("Caught interrupt signal");
      interrupted.resolve();
    });

    this.kafka = new Kafka({
      clientId: "feed-sqrl",
      brokers: [flags.kafka],
    });

    const consumer = this.kafka.consumer({ groupId: "process-feed" });

    await consumer.connect();

    const offsets = await this.kafka.admin().fetchTopicOffsets("inputEvents");

    await consumer.subscribe({
      topic: "inputEvents",
      fromBeginning: true,
    });

    let totalProcessed = 0;

    consumer.run({
      async eachMessage({ message }) {
        invariant(message.value);
        const data = JSON.parse(message.value.toString("utf-8"));

        const ctx = createSimpleContext();
        const execution = await executable.execute(ctx, {
          manipulator: new SimpleManipulator(),
          inputs: {
            EventName: data.eventName,
            EventPayload: data.payload,
          },
        });

        const author = await execution.fetchValue("Author");
        const count = await execution.fetchValue("CountByAuthor");

        await execution.fetchFeature("SqrlExecutionComplete");
        await execution.manipulator.mutate(ctx);

        totalProcessed += 1;
        console.log(`${author} [${count}] {@${totalProcessed}}`);
      },
    });

    // @todo: Does this actually seek to the start? after starting it?
    offsets.forEach(({ partition }) => {
      consumer.seek({
        topic: "inputEvents",
        partition,
        offset: FROM_EARLIEST.toString(),
      });
    });

    await interrupted.promise;
    await consumer.disconnect();
    // @todo: Close things
  }
}
