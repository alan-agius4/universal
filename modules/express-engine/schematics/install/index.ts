/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  strings,
  normalize,
  workspaces,
  join,
  parseJsonAst,
  JsonParseMode
} from '@angular-devkit/core';
import {
  apply,
  chain,
  externalSchematic,
  filter,
  mergeWith,
  noop,
  Rule,
  SchematicContext,
  SchematicsException,
  template,
  Tree,
  move,
  url,
} from '@angular-devkit/schematics';
import {NodePackageInstallTask} from '@angular-devkit/schematics/tasks';
import {Schema as UniversalOptions} from './schema';
import {
  addPackageJsonDependency,
  NodeDependencyType,
} from '@schematics/angular/utility/dependencies';
import {getWorkspace, updateWorkspace} from '@schematics/angular/utility/workspace';
import {
  findPropertyInAstObject,
  appendValueInAstArray,
} from '@schematics/angular/utility/json-utils';

async function getClientProject(host, projectName: string): Promise<workspaces.ProjectDefinition> {
  const workspace = await getWorkspace(host);
  const clientProject = workspace.projects.get(projectName);

  if (!clientProject || clientProject.extensions.projectType !== 'application') {
    throw new SchematicsException(`Universal requires a project type of "application".`);
  }

  return clientProject;
}

function forceTsExtension(file: string): string {
  return `${file.replace(/\.ts$/, '')}.ts`;
}

function addDependenciesAndScripts(options: UniversalOptions, serverDist: string): Rule {
  return (host: Tree) => {
    addPackageJsonDependency(host, {
      type: NodeDependencyType.Default,
      name: '@nguniversal/express-engine',
      version: '0.0.0-PLACEHOLDER',
    });
    addPackageJsonDependency(host, {
      type: NodeDependencyType.Default,
      name: 'express',
      version: 'EXPRESS_VERSION',
    });
    addPackageJsonDependency(host, {
      type: NodeDependencyType.Dev,
      name: '@types/express',
      version: 'EXPRESS_TYPES_VERSION',
    });

    const pkgPath = '/package.json';
    const buffer = host.read(pkgPath);
    if (buffer === null) {
      throw new SchematicsException('Could not find package.json');
    }

    const pkg = JSON.parse(buffer.toString());
    pkg.scripts = {
      ...pkg.scripts,
      'serve:ssr': `node ${serverDist}/main.js`,
      'build:ssr': 'npm run build:client-and-server-bundles',
      // tslint:disable-next-line: max-line-length
      'build:client-and-server-bundles': `ng build --prod && ng run ${options.clientProject}:server:production`,
    };

    host.overwrite(pkgPath, JSON.stringify(pkg, null, 2));

    return host;
  };
}

function updateConfigFile(options: UniversalOptions, browserDist: string, serverDist: string) {
  return updateWorkspace((workspace => {
    const clientProject = workspace.projects.get(options.clientProject);
    if (clientProject) {
      const buildTarget = clientProject.targets.get('build');
      const serverTarget = clientProject.targets.get('server');

      // We have to check if the project config has a server target, because
      // if the Universal step in this schematic isn't run, it can't be guaranteed
      // to exist
      if (!serverTarget || !buildTarget) {
        return;
      }

      serverTarget.options = {
        ...serverTarget.options,
        outputPath: serverDist,
      };

      serverTarget.options.main = join(
        normalize(clientProject.root),
        forceTsExtension(options.serverFileName),
      );

      buildTarget.options = {
        ...buildTarget.options,
        outputPath: browserDist,
      };
    }
  }));
}

function updateServerTsConfig(options: UniversalOptions): Rule {
  return async host => {
    const clientProject = await getClientProject(host, options.clientProject);
    const serverTarget = clientProject.targets.get('server');
    const tsConfigPath = serverTarget.options.tsConfig;
    if (!tsConfigPath || typeof tsConfigPath !== 'string') {
      // No tsconfig path
      return;
    }

    const configBuffer = host.read(tsConfigPath);
    if (!configBuffer) {
      throw new SchematicsException(`Could not find (${tsConfigPath})`);
    }

    const content = configBuffer.toString();
    const tsConfigAst = parseJsonAst(content, JsonParseMode.Loose);
    if (!tsConfigAst || tsConfigAst.kind !== 'object') {
      throw new SchematicsException(`Invalid JSON AST Object (${tsConfigPath})`);
    }

    const filesAstNode = findPropertyInAstObject(tsConfigAst, 'files');

    if (filesAstNode && filesAstNode.kind === 'array') {
      const rootInSrc = tsConfigPath.includes('src/');
      const rootSrc = rootInSrc ? '' : 'src/';
      const recorder = host.beginUpdate(tsConfigPath);

      appendValueInAstArray(
        recorder,
        filesAstNode,
        join(
          normalize(rootSrc),
          forceTsExtension(options.serverFileName),
        ),
      );

      host.commitUpdate(recorder);
    }
  };
}

export default function (options: UniversalOptions): Rule {
  return async (host: Tree, context: SchematicContext) => {
    // Generate new output paths
    const clientProject = await getClientProject(host, options.clientProject);
    const {options: clientBuildOptions} = clientProject.targets.get('build');
    const clientOutputPath = normalize(
         typeof clientBuildOptions.outputPath === 'string' ? clientBuildOptions.outputPath : 'dist'
    );

    const browserDist = join(clientOutputPath, 'browser');
    const serverDist = join(clientOutputPath, 'server');

    if (!options.skipInstall) {
      context.addTask(new NodePackageInstallTask());
    }

    const rootSource = apply(url('./files/root'), [
      options.skipServer ? filter(path => !path.startsWith('__serverFileName')) : noop(),
      template({
        ...strings,
        ...options,
        forceTsExtension,
        // remove the leading slashes
        getBrowserDistDirectory: () => browserDist,
      }),
      move(clientProject.root)
    ]);

    return chain([
      clientProject.targets.has('server')
        ? noop()
        : externalSchematic('@schematics/angular', 'universal', options),
      updateConfigFile(options, browserDist, serverDist),
      mergeWith(rootSource),
      addDependenciesAndScripts(options, serverDist),
      options.skipServer ? noop() : updateServerTsConfig(options),
    ]);
  };
}
