import {
  Execution,
  AT,
  createInstance,
  compileFromFilesystem,
  VirtualFilesystem,
  createSimpleContext,
  SimpleManipulator,
  Context,
} from "sqrl";
import * as sqrlJsonPath from "sqrl-jsonpath";
import * as sqrlLoadFunctions from "sqrl-load-functions";
import * as sqrlRedisFunctions from "sqrl-redis-functions";
import * as sqrlTextFunctions from "sqrl-text-functions";

import * as fs from "fs";
import { join as joinPath } from "path";
import { invariant } from "../util/invariant";
import { Manipulator } from "./Manipulator";

async function readDirContents(
  path: string
): Promise<{ [name: string]: string }> {
  const result: { [name: string]: string } = {};
  const files = await fs.promises.readdir(path);

  await Promise.all(
    files.map(async (file) => {
      const fullPath = joinPath(path, file);
      const contents = await fs.promises.readFile(fullPath, "utf-8");
      result[file] = contents;
    })
  );
  return result;
}

export async function compileSqrl() {
  const instance = createInstance({
    config: {
      "state.allow-in-memory": true,
      "sqrl-text-functions": {
        builtinRegExp: true,
      },
    },
  });
  await instance.importFromPackage("sqrl-jsonpath", sqrlJsonPath);
  await instance.importFromPackage("sqrl-redis-functions", sqrlRedisFunctions);
  await instance.importFromPackage("sqrl-text-functions", sqrlTextFunctions);
  await instance.importFromPackage("sqrl-load-functions", sqrlLoadFunctions);

  instance.registerStatement(
    "SqrlWriteStatements",
    async function bigqueryWrite(
      state: Execution,
      table: string,
      payload: any
    ) {
      invariant(
        state.manipulator instanceof Manipulator,
        "Expected custom Manipulator"
      );
      state.manipulator.kafkaWrite("bigQuery", JSON.stringify(payload));
    },
    {
      allowNull: true,
      args: [AT.state, AT.constant.string, AT.any],
      argstring: "table name, payload",
      docstring: "Write a row to bigquery",
    }
  );

  // @todo: If this is moved
  const files = await readDirContents(joinPath(__dirname, "../sqrl"));
  const vfs = new VirtualFilesystem(files);
  const { executable } = await compileFromFilesystem(instance, vfs);
  return executable;
}
