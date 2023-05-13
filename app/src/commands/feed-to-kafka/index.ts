import { Args, Command, Config, Flags } from '@oclif/core'

import { Subscription } from '@atproto/xrpc-server'
import { ids, lexicons } from '../../bluesky/lexicon/lexicons'
import {
  Commit,
  OutputSchema as RepoEvent,
  isCommit,
} from '../../bluesky/lexicon/types/com/atproto/sync/subscribeRepos'
import { getOpsByType } from '../../bluesky/getOpsByType'

import { EachMessageHandler, Kafka } from 'kafkajs'
import { invariant } from '../../util/invariant'
import { DeferredPromise } from '../../util/DeferredPromise'


class Pacer {

  private last = 0;
  constructor(private intervalMs: number) {


  }

  test() {
    const now = Date.now();
    if (now > this.last + this.intervalMs) {
      this.last = now;
      return true;
    }
    return false;
  }
}


async function consumeAll(kafka: Kafka, topic: string, callback: EachMessageHandler) {
  const consumer = kafka.consumer({ groupId: 'test-group' })

  await consumer.connect()


  const finishedPromise = new DeferredPromise<void>();

  /*
   * 1. We need to know which partitions we are assigned.
   * 2. Which partitions have we consumed the last offset for
   * 3. If all partitions have 0 lag, we exit.
   */

  /*
   * `consumedTopicPartitions` will be an object of all topic-partitions
   * and a boolean indicating whether or not we have consumed all
   * messages in that topic-partition. For example:
   *
   * {
   *   "topic-test-0": false,
   *   "topic-test-1": false,
   *   "topic-test-2": false
   * }
   */
  let consumedTopicPartitions: { [partition: string]: boolean } = {}
  consumer.on(consumer.events.GROUP_JOIN, async ({ payload }) => {
    const { memberAssignment } = payload
    consumedTopicPartitions = Object.entries(memberAssignment).reduce(
      (topics, [topic, partitions]) => {
        for (const partition in partitions) {
          topics[`${topic}-${partition}`] = false
        }
        return topics
      },
      {} as { [partition: string]: boolean }
    )
  })

  /*
   * This is extremely unergonomic, but if we are currently caught up to the head
   * of all topic-partitions, we won't actually get any batches, which means we'll
   * never find out that we are actually caught up. So as a workaround, what we can do
   * is to check in `FETCH_START` if we have previously made a fetch without
   * processing any batches in between. If so, it means that we received empty
   * fetch responses, meaning there was no more data to fetch.
   *
   * We need to initially set this to true, or we would immediately exit.
   */
  let processedBatch = true
  consumer.on(consumer.events.FETCH_START, async () => {
    if (processedBatch === false) {
      finishedPromise.resolve();
    }

    processedBatch = false
  })

  /*
   * Now whenever we have finished processing a batch, we'll update `consumedTopicPartitions`
   * and exit if all topic-partitions have been consumed,
   */
  consumer.on(consumer.events.END_BATCH_PROCESS, async ({ payload }) => {
    const { topic, partition, offsetLag } = payload
    consumedTopicPartitions[`${topic}-${partition}`] = offsetLag === '0'

    if (Object.values(consumedTopicPartitions).every(consumed => Boolean(consumed))) {
      finishedPromise.resolve();
    }

    processedBatch = true
  })

  await consumer.subscribe({ topic, fromBeginning: true })

  await consumer.run({
    eachMessage: callback
  })

  await finishedPromise.promise;
  await consumer.disconnect()
}

/*
run().catch(e => console.error(`[example/consumer] ${e.message}`, e))

const errorTypes = ['unhandledRejection', 'uncaughtException']
const signalTraps = ['SIGTERM', 'SIGINT', 'SIGUSR2']

errorTypes.map(type => {
  process.on(type, async e => {
    try {
      console.log(`process.on ${type}`)
      console.error(e)
      await consumer.disconnect()
      process.exit(0)
    } catch (_) {
      process.exit(1)
    }
  })
})

signalTraps.map(type => {
  process.once(type, async () => {
    try {
      await consumer.disconnect()
    } finally {
      process.kill(process.pid, type)
    }
  })
})
*/


export default class FeedToKafka extends Command {
  static description = 'Write the BlueSky feed to a kafka instance'


  static flags = {
    kafka: Flags.string({
      description: 'Kafka server', required: true,
      default: 'localhost:9092'
    }),
  }

  private kafka: Kafka | null = null;

  async getSubscribeParams() {
    invariant(this.kafka);

    let cursor: number | null = null;
    await consumeAll(this.kafka, 'feedStatus', async ({ message }) => {
      // @todo: Legacy handle key=null
      if (message.key === null || message.key.toString('utf-8') === 'cursor') {
        invariant(message.value, 'Expected message to have value set');
        const data = JSON.parse(message.value?.toString());
        cursor = Math.max(cursor ?? 0, data.cursor);
      }
    })

    console.log('Consuming from cursor:', cursor);
    if (cursor) {
      return { cursor };
    }
    return {};
  }

  async run(): Promise<void> {


    let shouldExit = false;
    let totalCommitted = 0;
    let lastLag: number | null = null;

    const logPacer = new Pacer(15000);

    process.on('SIGINT', function () {
      console.log("Caught interrupt signal");
      shouldExit = true;
    });


    const { flags } = await this.parse(FeedToKafka)

    this.kafka = new Kafka({
      clientId: 'bluesky-feed',
      brokers: [flags.kafka],
    })


    const producer = this.kafka.producer({
      transactionalId: 'bluesky-feed-producer',
      maxInFlightRequests: 1,
      idempotent: true
    })

    console.log('Connecting producer...')
    await producer.connect()


    const sub = new Subscription({
      service: 'wss://bsky.social',
      method: ids.ComAtprotoSyncSubscribeRepos,
      getParams: () => this.getSubscribeParams(),
      validate: (value: unknown) => {
        try {
          return lexicons.assertValidXrpcMessage<RepoEvent>(
            ids.ComAtprotoSyncSubscribeRepos,
            value,
          )
        } catch (err) {
          console.error('repo subscription skipped invalid message', err)
        }
      },
    })


    for await (const evt of sub) {

      // @todo: Ideally this would be published in a transaction
      const eventKafkaMessages: string[] = [];


      if (isCommit(evt)) {
        const ops = await getOpsByType(evt)

        for (const [eventName, events] of [
          ['create-follow', ops.follows.creates],
          ['delete-follow', ops.follows.deletes],
          ['create-post', ops.posts.creates],
          ['delete-post', ops.posts.deletes],
          ['create-like', ops.likes.creates],
          ['delete-like', ops.likes.deletes],
          ['create-repost', ops.reposts.creates],
          ['delete-repost', ops.reposts.deletes],
        ] as Array<[string, any]>) {
          for (const event of events) {

            const createdAt: string | undefined = event.record?.createdAt;

            if (createdAt) {
              lastLag = Date.now() - Date.parse(createdAt);
            }

            eventKafkaMessages.push(JSON.stringify(
              {
                v: 1,
                eventName,
                payload: event
              }
            ));
          }
        }


        if (!eventKafkaMessages.length) {
          continue;
        }


        const transaction = await producer.transaction()

        try {
          await transaction.send({
            topic: 'inputEvents',
            messages: eventKafkaMessages.map(value => ({ value })),
          })
          await transaction.send(
            {
              topic: 'feedStatus',
              messages: [{
                key: 'cursor',
                value: JSON.stringify({
                  cursor: evt.seq
                })
              }]
            })

          await transaction.commit()
        } catch (e) {
          invariant(e instanceof Error, 'Expected error')
          shouldExit = true;
          console.error('Error during transaction: ' + e.toString())
          await transaction.abort()
        }

        totalCommitted += eventKafkaMessages.length;
        if (logPacer.test()) {
          console.log(`Committed ${totalCommitted} messages! Lag ${lastLag} ms`)
        }

      }

      if (shouldExit) {
        break;
      }
    }

    await producer.disconnect();
    // @todo: Close things

  }
}
