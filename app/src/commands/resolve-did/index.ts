import { Args, Command } from "@oclif/core";

import { resolveDid } from "../../sqrl-functions/resolveDid";
import { Trace } from "../../util/Trace";

export default class ResolveDID extends Command {
  static description = "Resolve a BlueSky DID";

  static flags = {};
  static args = {
    did: Args.string({
      name: "did",
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ResolveDID);
    const trc = new Trace();

    console.log(await resolveDid(trc, args.did));
  }
}
