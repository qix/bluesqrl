import { Args, Command } from "@oclif/core";

import { resolveDid } from "../../sqrl-functions/resolveDid";

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

    console.log(await resolveDid(args.did));
  }
}
