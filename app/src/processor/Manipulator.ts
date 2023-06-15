import { Producer } from "kafkajs";
import { Context, SimpleManipulator } from "sqrl";
import { invariant } from "../util/invariant";

export class Manipulator extends SimpleManipulator {
  private messages: {
    [topic: string]: Buffer[];
  } = {};
  private readonly = false;

  constructor(private producer: Producer | null) {
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
    invariant(this.producer, "Unable to produce to kafka with null producer");

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
    invariant(this.producer, "Unable to mutate with null producer");
    this.readonly = true;
    await Promise.all([super.mutate(ctx), this.kafkaProduce()]);
  }
}
