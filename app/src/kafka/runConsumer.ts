import { EachBatchHandler, EachMessageHandler, Kafka } from "kafkajs";
import { DeferredPromise } from "../util/DeferredPromise";
import { Flags } from "@oclif/core";

// @todo: Get this from kafkajs?
const FROM_EARLIEST = -2;

export function kafkaConsumerFlags(defaultGroupId: string) {
  return {
    kafka: Flags.string({
      description: "Kafka server",
      required: true,
      default: "localhost:9092",
    }),
    kafkaClientId: Flags.string({
      description: "Kafka clientId",
      default: "bluesqrl-cli",
    }),
    kafkaGroupId: Flags.string({
      description: "Kafka groupId",
      default: defaultGroupId,
    }),
    restart: Flags.boolean({
      description: "Restart consumer from the beginning",
      default: false,
    }),
    restartIfInvalid: Flags.boolean({
      description:
        "Restart consumer from the beginning if there is no offset set",
      default: false,
    }),
  };
}
export function createKafkaClient(flags: {
  kafka: string;
  kafkaClientId: string;
}) {
  return new Kafka({
    clientId: flags.kafkaClientId,
    brokers: [flags.kafka],
  });
}

export async function runConsumer(props: {
  kafka: Kafka;
  topic: string;
  flags: {
    restart?: boolean;
    restartIfInvalid?: boolean;
    kafkaGroupId: string;
  };
  eachMessage?: EachMessageHandler;
  eachBatch?: EachBatchHandler;
}) {
  const { topic, kafka, eachBatch, eachMessage, flags } = props;

  const interrupted = new DeferredPromise<void>();
  process.on("SIGINT", function () {
    console.log("Caught interrupt signal");
    interrupted.resolve();
  });

  const admin = kafka.admin();
  const consumer = kafka.consumer({ groupId: flags.kafkaGroupId });

  console.log("Connecting consumer...");
  await consumer.connect();
  await consumer.subscribe({
    topic,
    fromBeginning: flags.restart || flags.restartIfInvalid,
  });

  if (flags.restart) {
    /* For some reason we can only seek after starting the consumer,
     * but assume that it immediately seeks
     * @todo: Check this assumption
     */
    const offsets = await admin.fetchTopicOffsets(topic);
    console.log("Resetting consumer...");
    consumer.run({
      eachMessage,
      eachBatch,
    });
    offsets.forEach(({ partition }) => {
      consumer.seek({
        topic,
        partition,
        offset: FROM_EARLIEST.toString(),
      });
    });
  } else {
    consumer.run({
      eachMessage,
      eachBatch,
    });
  }

  await interrupted.promise;
  console.log("Disconnecting...");
  await Promise.all([consumer.disconnect(), admin.disconnect()]);
}
