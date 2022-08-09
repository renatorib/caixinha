import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import * as swc from "@swc/core";

const readFile = util.promisify(fs.readFile);

const createGraph = async (entry: string) => {
  let ID = 0;

  type Module = {
    // Unique ID of module
    id: number;
    // "Browserified" code
    code: string;
    // Mapped local imports strings to other modules IDs
    dependencies: Map<string, number>;
    // Module extension
    extension: string;
  };

  let modules = new Map<string, Module>();

  const createModule = async (filename: string) => {
    const absoluteFile = path.join(process.cwd(), filename) + (path.extname(filename) === "" ? ".ts" : "");
    const cachedModule = modules.get(absoluteFile);

    if (!cachedModule) {
      const id = ID++;
      const content = await readFile(absoluteFile, "utf8");

      const [{ code }, ast] = await Promise.all([
        swc.transform(content, { filename, module: { type: "commonjs" } }),
        swc.parse(content, { syntax: "typescript" }),
      ]);

      const dependencies = new Map<string, number>();

      const imports = ast.body.filter((node): node is Extract<typeof node, { type: "ImportDeclaration" }> => {
        return node.type === "ImportDeclaration";
      });

      await Promise.all(
        imports.map((node) => {
          return new Promise(async (resolve) => {
            const source = node.source.value;
            const mod = await createModule(path.join(path.dirname(filename), source));
            dependencies.set(source, mod.id);
            resolve(undefined);
          });
        })
      );

      const mod: Module = {
        id,
        code,
        dependencies,
        extension: path.extname(absoluteFile),
      };

      modules.set(absoluteFile, mod);
      return mod;
    } else {
      return cachedModule;
    }
  };

  await createModule(entry);

  return modules;
};

export const bundle = async (entry: string) => {
  const modules = await createGraph(entry);

  const output = `
    (function (modules) {
      function require(id) {
        const [fn, dependencies] = modules[id];
        function localRequire(name) {
          return require(dependencies[name]);
        }
        const module = { exports : {} };
        fn(localRequire, module, module.exports);
        return module.exports;
      }
      require(0);
    })({
      ${[...modules.values()]
        .map(
          (mod) => `${mod.id}: [
            function (require, module, exports) {
              ${mod.code}
            },
            ${JSON.stringify(Object.fromEntries(mod.dependencies))}
          ]`
        )
        .join(",\n")}
    })
  `;

  const minified = await swc.minify(output, { compress: true });
  return minified.code;
};
