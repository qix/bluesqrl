import { Args, Command, Flags } from '@oclif/core'

import { Subscription } from '@atproto/xrpc-server'
import { ids, lexicons } from '../../bluesky/lexicon/lexicons'
import {
  Commit,
  OutputSchema as RepoEvent,
  isCommit,
} from '../../bluesky/lexicon/types/com/atproto/sync/subscribeRepos'
import { getOpsByType } from '../../bluesky/getOpsByType'


export default class FeedToKafka extends Command {
  static description = 'Write the BlueSky feed to a kafka instance'


  /*
  static flags = {
    from: Flags.string({char: 'f', description: 'Who is saying hello', required: true}),
  }

  static args = {
    person: Args.string({description: 'Person to say hello to', required: true}),
  }
  */

  async getCursor() {
    // {cursor: ''}
    return {};
  }
  async run(): Promise<void> {
    // const {args, flags} = await this.parse(Hello)
    // this.log(`hello ${args.person} from ${flags.from}! (./src/commands/hello/index.ts)`)

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
        ]) {
          for (const event of events) {
            console.log(eventName, JSON.stringify(event));
          }
        }
      }

      try {
        //await this.handleEvent(evt)
      } catch (err) {
        console.error('repo subscription could not handle message', err)
      }

      // update stored cursor every 20 events or so
      if (isCommit(evt) && evt.seq % 20 === 0) {
        console.log('SET CURSOR', evt.seq);
      }
    }

  }
}
