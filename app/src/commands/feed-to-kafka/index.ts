import { Args, Command, Flags } from '@oclif/core'

import { Subscription } from '@atproto/xrpc-server'
import { ids, lexicons } from '../../bluesky/lexicon/lexicons'
import {
  Commit,
  OutputSchema as RepoEvent,
  isCommit,
} from '../../bluesky/lexicon/types/com/atproto/sync/subscribeRepos'
import { getOpsByType } from '../../bluesky/getOpsByType'

import { KafkaClient as Client, HighLevelProducer } from 'kafka-node';

const kafkaHost = 'localhost:9092';


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

export default class FeedToKafka extends Command {
  static description = 'Write the BlueSky feed to a kafka instance'


  static flags = {
    kafka: Flags.string({
      description: 'Kafka server', required: true,
      default: 'localhost:9092'
    }),
  }

  async getCursor() {
    // {cursor: ''}
    return {};
  }
  async run(): Promise<void> {


    let shouldExit = false;
    let totalCommitted = 0;
    const logPacer = new Pacer(15000);

    process.on('SIGINT', function () {
      console.log("Caught interrupt signal");
      shouldExit = true;
    });


    const { flags } = await this.parse(FeedToKafka)

    const kafkaClient = new Client({
      kafkaHost: flags.kafka,
      clientId: 'bluesky-feed'
    });

    const producer = new HighLevelProducer(kafkaClient, { requireAcks: 1 });

    producer.on('error', function (err) {
      console.log('Producer error', err);
    });

    console.log('Connecting to producer...')
    await new Promise<void>((resolve, reject) => {
      producer.on('ready', resolve);
      // @todo: handle errors
    })
    console.log('Producer ready')


    const cursor = {}; // {cursor: ''}

    const sub = new Subscription({
      service: 'wss://bsky.social',
      method: ids.ComAtprotoSyncSubscribeRepos,
      getParams: () => this.getCursor(),
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
        const producerMessages = [
          {
            topic: 'inputEvents',
            messages: eventKafkaMessages,
          },
          {
            topic: 'feedStatus',
            messages: [JSON.stringify({
              cursor: evt.seq
            })]
          }
        ];

        await new Promise(resolve => {
          setTimeout(resolve, 100)
        })
        producer.send(producerMessages, (err, data) => {
          if (err) {
            console.error('produceFailed', err);
          } else {
            totalCommitted += eventKafkaMessages.length;
            if (logPacer.test()) {
              console.log(`Committed ${totalCommitted} messages!`)
            }
          }
        });

      }

      if (shouldExit) {
        break;
      }
    }

    // @todo: Close things

  }
}
