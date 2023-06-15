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
import { AtUri } from "@atproto/uri";
import { resolveDid } from "../../sqrl-functions/resolveDid";

import { promisify } from "util";
import { gzip } from "zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const gzipAsync = promisify(gzip);

const PLC_REGEX = /^did:plc:[a-z0-9]{24}$/;

async function resolveDids(values: string[]) {
  const dids = new Set<string>();
  for (const value of values) {
    if (PLC_REGEX.test(value)) {
      dids.add(value);
    } else if (value.startsWith("at://")) {
      const parsed = new AtUri(value);
      if (PLC_REGEX.test(parsed.host)) {
        dids.add(parsed.host);
      }
    }
  }

  const didMap: { [did: string]: string } = {};
  await Promise.all(
    Array.from(dids).map((did) => {
      return resolveDid(did).then((resolved) => {
        didMap[did] = resolved;
      });
    })
  );
  return didMap;
}

function minuteString(date: Date) {
  const str = date.toISOString();
  return str.substring(0, "0000-00-00Y00:00".length);
}

class S3Streamer {
  private minuteEvents: Array<any> = [];
  private currentMinute: string | null = null;

  private s3: S3Client;
  constructor(
    private region: string,
    private bucket: string,
    private keyPrefix: string
  ) {
    this.s3 = new S3Client({
      region: this.region,
    });
  }

  async uploadMinute(timestamp: string, events: Array<any>) {
    const fileContents = JSON.stringify({
      v: 0,
      timestamp,
      events,
    });

    const compressed = await gzipAsync(fileContents);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Body: compressed,
        Key: `${this.keyPrefix}/${timestamp}.js`,
        ContentType: "text/javascript",
        ContentEncoding: "gzip",
      })
    );
  }

  async addEvent(timestamp: Date, event: any) {
    let eventMinute = minuteString(timestamp);
    if (this.currentMinute === null) {
      this.currentMinute = eventMinute;
    }

    // If the eventMinute is before the current minute, just overwrite it
    if (eventMinute.localeCompare(this.currentMinute) < 0) {
      eventMinute = this.currentMinute;
    }

    if (eventMinute !== this.currentMinute) {
      const prevMinute = this.currentMinute;
      const prevEvents = this.minuteEvents;
      this.currentMinute = eventMinute;
      this.minuteEvents = [];

      await this.uploadMinute(prevMinute, prevEvents).then(
        () => {
          console.log(
            `Upload of ${prevMinute} complete [${prevEvents.length} events]`
          );
        },
        (err) => {
          console.log(`Upload of ${prevMinute} failed: ${err}`);
          throw err;
        }
      );
    }

    this.minuteEvents.push(event);
  }
}

export default class WriteFeedS3 extends Command {
  static description = "Read the kafka feed and write data dumps to S3";

  static flags = {
    ...kafkaConsumerFlags("write-feed-s3"),
    region: Flags.string({
      description: "S3 Region",
      required: true,
    }),
    bucket: Flags.string({
      description: "S3 Bucket",
      required: true,
    }),
    "key-prefix": Flags.string({
      description: "S3 Key Prefix",
      required: true,
      options: ["dev/v0", "prod/v0"],
    }),
  };

  private kafka: Kafka | null = null;

  async run(): Promise<void> {
    const { flags } = await this.parse(WriteFeedS3);

    const streamer = new S3Streamer(
      flags.region,
      flags.bucket,
      flags["key-prefix"]
    );
    this.kafka = createKafkaClient(flags);

    let totalProcessed = 0;
    const pacer = new Pacer({
      intervalMs: 15000,
    });

    let lastTimestamp: string | null = null;
    await runConsumer({
      kafka: this.kafka,
      topic: "inputEvents",
      flags: flags,
      async eachMessage({ message }) {
        invariant(message.value);
        const data = JSON.parse(message.value.toString("utf-8"));
        const createdAt = data.payload?.record?.createdAt || lastTimestamp;
        if (typeof createdAt !== "string") {
          console.error("Skipping message without timestamp");
          return;
        }
        lastTimestamp = createdAt;

        const resolvedDids = await resolveDids(
          [
            data.payload?.reply?.root?.uri,
            data.payload?.reply?.parent?.uri,
            data.payload?.record?.subject?.uri,
            data.payload?.uri,
            data.payload?.author,
          ].filter((v) => v)
        );

        await streamer.addEvent(new Date(createdAt), {
          ...data,
          resolvedDids,
        });

        totalProcessed += 1;
        if (pacer.test()) {
          console.log(
            `Processed ${totalProcessed} messages, last at ${createdAt}`
          );
        }
      },
    });
  }
}
