/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {experimental, strings, normalize} from '@angular-devkit/core';
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
  url,
} from '@angular-devkit/schematics';
import {NodePackageInstallTask} from '@angular-devkit/schematics/tasks';
import {getWorkspace} from '@schematics/angular/utility/config';
import {Schema as UniversalOptions} from './schema';
import {
  addPackageJsonDependency,
  NodeDependencyType,
} from '@schematics/angular/utility/dependencies';
import {getProject} from '@schematics/angular/utility/project';
import {getProjectTargets} from '@schematics/angular/utility/project-targets';
import {InsertChange} from '@schematics/angular/utility/change';
import {findNodes, insertAfterLastOccurrence} from '@schematics/angular/utility/ast-utils';
import * as ts from 'typescript';
import {generateExport, getTsSourceFile, getTsSourceText} from './utils';
import {updateWorkspace} from '@schematics/angular/utility/workspace';

// TODO(CaerusKaru): make these configurable
const BROWSER_DIST = 'dist/browser';
const SERVER_DIST = 'dist/server';

function getClientProject(
  host: Tree, options: UniversalOptions,
): experimental.workspace.WorkspaceProject {
  const workspace = getWorkspace(host);
  const clientProject = workspace.projects[options.clientProject];
  if (!clientProject) {
    throw new SchematicsException(`Client app ${options.clientProject} not found.`);
  }

  return clientProject;
}

function addDependenciesAndScripts(options: UniversalOptions): Rule {
  return (host: Tree) => {
    addPackageJsonDependency(host, {
      type: NodeDependencyType.Default,
      name: '@nguniversal/hapi-engine',
      version: '0.0.0-PLACEHOLDER',
    });
    addPackageJsonDependency(host, {
      type: NodeDependencyType.Default,
      name: 'hapi',
      version: 'HAPI_VERSION',
    });
    addPackageJsonDependency(host, {
      type: NodeDependencyType.Default,
      name: 'inert',
      version: '^5.1.0',
    });

    if (options.webpack) {
      addPackageJsonDependency(host, {
        type: NodeDependencyType.Dev,
        name: 'ts-loader',
        version: '^5.2.0',
      });
      addPackageJsonDependency(host, {
        type: NodeDependencyType.Dev,
        name: 'webpack-cli',
        version: '^3.1.0',
      });
    }

    const serverFileName = options.serverFileName.replace('.ts', '');
    const pkgPath = '/package.json';
    const buffer = host.read(pkgPath);
    if (buffer === null) {
      throw new SchematicsException('Could not find package.json');
    }

    const pkg = JSON.parse(buffer.toString());
    pkg.scripts = {
      ...pkg.scripts,
      'compile:server': options.webpack
        ? 'webpack --config webpack.server.config.js --progress --colors'
        : `tsc -p ${serverFileName}.tsconfig.json`,
      'serve:ssr': `node dist/${serverFileName}`,
      'build:ssr': 'npm run build:client-and-server-bundles && npm run compile:server',
      // tslint:disable-next-line: max-line-length
      'build:client-and-server-bundles': `ng build --prod && ng run ${options.clientProject}:server:production`,
    };

    host.overwrite(pkgPath, JSON.stringify(pkg, null, 2));

    return host;
  };
}

function updateConfigFile(options: UniversalOptions) {
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
        outputPath: SERVER_DIST,
      };

      buildTarget.options = {
        ...buildTarget.options,
        outputPath: BROWSER_DIST,
      };
    }
  }));
}

function addExports(options: UniversalOptions): Rule {
  return (host: Tree) => {
    const clientProject = getProject(host, options.clientProject);
    const clientTargets = getProjectTargets(clientProject);

    if (!clientTargets.server) {
      // If they skipped Universal schematics and don't have a server target,
      // just get out
      return;
    }

    const mainPath = normalize('/' + clientTargets.server.options.main);
    const mainSourceFile = getTsSourceFile(host, mainPath);
    let mainText = getTsSourceText(host, mainPath);
    const mainRecorder = host.beginUpdate(mainPath);
    const hapiEngineExport = generateExport(mainSourceFile, ['ngHapiEngine'],
      '@nguniversal/hapi-engine');
    const exports = findNodes(mainSourceFile, ts.SyntaxKind.ExportDeclaration);
    const addedExports = `\n${hapiEngineExport}\n`;
    const exportChange = insertAfterLastOccurrence(exports, addedExports, mainText,
      0) as InsertChange;

    mainRecorder.insertLeft(exportChange.pos, exportChange.toAdd);
    host.commitUpdate(mainRecorder);
  };
}

export default function (options: UniversalOptions): Rule {
  return (host: Tree, context: SchematicContext) => {
    const clientProject = getClientProject(host, options);
    if (clientProject.projectType !== 'application') {
      throw new SchematicsException(`Universal requires a project type of "application".`);
    }

    if (!options.skipInstall) {
      context.addTask(new NodePackageInstallTask());
    }

    const rootSource = apply(url('./files/root'), [
      options.skipServer ? filter(path => !path.startsWith('__serverFileName')) : noop(),
      options.webpack ?
        filter(path => !path.includes('tsconfig')) : filter(path => !path.startsWith('webpack')),
      template({
        ...strings,
        ...options as object,
        stripTsExtension: (s: string) => s.replace(/\.ts$/, ''),
        getBrowserDistDirectory: () => BROWSER_DIST,
        getServerDistDirectory: () => SERVER_DIST,
      })
    ]);

    return chain([
      options.skipUniversal ?
        noop() : externalSchematic('@schematics/angular', 'universal', options),
      updateConfigFile(options),
      mergeWith(rootSource),
      addDependenciesAndScripts(options),
      addExports(options),
    ]);
  };
}
