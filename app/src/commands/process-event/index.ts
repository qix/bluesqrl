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
import * as fs from "fs";
export default class ProcessFeed extends Command {
  static description = "Process a single event via stdin with SQRL";

  static flags = {};

  async run(): Promise<void> {
    const { flags } = await this.parse(ProcessFeed);

    const eventJson = await fs.promises.readFile("/dev/stdin", "utf-8");

    const executable = await compileSqrl();

    const data = JSON.parse(eventJson);

    const ctx = createSimpleContext();
    const execution = await executable.execute(ctx, {
      manipulator: new Manipulator(null),
      inputs: {
        EventName: data.eventName,
        EventPayload: data.payload,
      },
    });

    await execution.fetchFeature("SqrlExecutionComplete");
  }
}
