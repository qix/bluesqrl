import { Command, Flags } from "@oclif/core";

import { Kafka, Producer } from "kafkajs";
import { invariant } from "../../util/invariant";
import { createSimpleContext, SimpleManipulator, Context } from "sqrl";
import {
  createKafkaClient,
  kafkaConsumerFlags,
  runConsumer,
} from "../../kafka/runConsumer";
import { Pacer } from "../../util/Pacer";
import { compileSqrl } from "../../processor/compileSqrl";
import { Manipulator } from "../../processor/Manipulator";

export default class ProcessFeed extends Command {
  static description = "Read the kafka feed and process it with SQRL";

  static flags = kafkaConsumerFlags("process-feed");

  private kafka: Kafka | null = null;

  async run(): Promise<void> {
    const { flags } = await this.parse(ProcessFeed);

    const executable = await compileSqrl();

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
      flags: flags,
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
