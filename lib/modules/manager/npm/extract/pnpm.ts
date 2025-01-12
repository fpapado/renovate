import is from '@sindresorhus/is';
import { findPackages } from 'find-packages';
import upath from 'upath';
import { z } from 'zod';
import { GlobalConfig } from '../../../../config/global';
import { logger } from '../../../../logger';
import {
  findLocalSiblingOrParent,
  getSiblingFileName,
  localPathExists,
  readLocalFile,
} from '../../../../util/fs';
import { parseSingleYaml } from '../../../../util/yaml';
import type {
  PackageDependency,
  PackageFile,
  PackageFileContent,
} from '../../types';
import type { PnpmDependencySchema, PnpmLockFile } from '../post-update/types';
import type { NpmManagerData } from '../types';
import { extractDependency, parseDepName } from './common/dependency';
import type { LockFile, PnpmCatalog, PnpmWorkspaceFile } from './types';

function isPnpmLockfile(obj: any): obj is PnpmLockFile {
  return is.plainObject(obj) && 'lockfileVersion' in obj;
}

export async function extractPnpmFilters(
  fileName: string,
): Promise<string[] | undefined> {
  try {
    // TODO: use schema (#9610,#22198)
    const contents = parseSingleYaml<PnpmWorkspaceFile>(
      (await readLocalFile(fileName, 'utf8'))!,
    );
    if (
      !Array.isArray(contents.packages) ||
      !contents.packages.every((item) => is.string(item))
    ) {
      logger.trace(
        { fileName },
        'Failed to find required "packages" array in pnpm-workspace.yaml',
      );
      return undefined;
    }
    return contents.packages;
  } catch (err) {
    logger.trace({ fileName, err }, 'Failed to parse pnpm-workspace.yaml');
    return undefined;
  }
}

export async function findPnpmWorkspace(
  packageFile: string,
): Promise<{ lockFilePath: string; workspaceYamlPath: string } | null> {
  // search for pnpm-workspace.yaml
  const workspaceYamlPath = await findLocalSiblingOrParent(
    packageFile,
    'pnpm-workspace.yaml',
  );
  if (!workspaceYamlPath) {
    logger.trace(
      { packageFile },
      'Failed to locate pnpm-workspace.yaml in a parent directory.',
    );
    return null;
  }

  // search for pnpm-lock.yaml next to pnpm-workspace.yaml
  const pnpmLockfilePath = getSiblingFileName(
    workspaceYamlPath,
    'pnpm-lock.yaml',
  );
  if (!(await localPathExists(pnpmLockfilePath))) {
    logger.trace(
      { workspaceYamlPath, packageFile },
      'Failed to find a pnpm-lock.yaml sibling for the workspace.',
    );
    return null;
  }

  return {
    lockFilePath: pnpmLockfilePath,
    workspaceYamlPath,
  };
}

export async function detectPnpmWorkspaces(
  packageFiles: Partial<PackageFile<NpmManagerData>>[],
): Promise<void> {
  logger.debug(`Detecting pnpm Workspaces`);
  const packagePathCache = new Map<string, string[] | null>();

  for (const p of packageFiles) {
    const { packageFile, managerData = {} } = p;
    const { pnpmShrinkwrap } = managerData as Partial<NpmManagerData>;

    // check if pnpmShrinkwrap-file has already been provided
    if (pnpmShrinkwrap) {
      logger.trace(
        { packageFile, pnpmShrinkwrap },
        'Found an existing pnpm shrinkwrap file; skipping pnpm monorepo check.',
      );
      continue;
    }

    // search for corresponding pnpm workspace
    // TODO #22198
    const pnpmWorkspace = await findPnpmWorkspace(packageFile!);
    if (pnpmWorkspace === null) {
      continue;
    }
    const { workspaceYamlPath, lockFilePath } = pnpmWorkspace;

    // check if package matches workspace filter
    if (!packagePathCache.has(workspaceYamlPath)) {
      const filters = await extractPnpmFilters(workspaceYamlPath);
      const localDir = GlobalConfig.get('localDir');
      const packages = await findPackages(
        upath.dirname(upath.join(localDir, workspaceYamlPath)),
        {
          patterns: filters,
          // Match the ignores used in @pnpm/find-workspace-packages
          ignore: ['**/node_modules/**', '**/bower_components/**'],
        },
      );
      const packagePaths = packages.map((pkg) =>
        upath.join(pkg.dir, 'package.json'),
      );
      packagePathCache.set(workspaceYamlPath, packagePaths);
    }
    const packagePaths = packagePathCache.get(workspaceYamlPath);

    const isPackageInWorkspace = packagePaths?.some((p) =>
      p.endsWith(packageFile!),
    );

    if (isPackageInWorkspace) {
      p.managerData ??= {};
      p.managerData.pnpmShrinkwrap = lockFilePath;
    } else {
      logger.trace(
        { packageFile, workspaceYamlPath },
        `Didn't find the package in the pnpm workspace`,
      );
    }
  }
}

export async function getPnpmLock(filePath: string): Promise<LockFile> {
  try {
    const pnpmLockRaw = await readLocalFile(filePath, 'utf8');
    if (!pnpmLockRaw) {
      throw new Error('Unable to read pnpm-lock.yaml');
    }

    const lockParsed = parseSingleYaml(pnpmLockRaw);
    if (!isPnpmLockfile(lockParsed)) {
      throw new Error('Invalid or empty lockfile');
    }
    logger.trace({ lockParsed }, 'pnpm lockfile parsed');

    // field lockfileVersion is type string in lockfileVersion = 6 and type number in < 6
    const lockfileVersion: number = is.number(lockParsed.lockfileVersion)
      ? lockParsed.lockfileVersion
      : parseFloat(lockParsed.lockfileVersion);

    const lockedVersions = getLockedVersions(lockParsed);

    return {
      lockedVersionsWithPath: lockedVersions,
      lockfileVersion,
    };
  } catch (err) {
    logger.debug({ filePath, err }, 'Warning: Exception parsing pnpm lockfile');
    return { lockedVersions: {} };
  }
}

function getLockedVersions(
  lockParsed: PnpmLockFile,
): Record<string, Record<string, Record<string, string>>> {
  const lockedVersions: Record<
    string,
    Record<string, Record<string, string>>
  > = {};

  // monorepo
  if (is.nonEmptyObject(lockParsed.importers)) {
    for (const [importer, imports] of Object.entries(lockParsed.importers)) {
      lockedVersions[importer] = getLockedDependencyVersions(imports);
    }
  }
  // normal repo
  else {
    lockedVersions['.'] = getLockedDependencyVersions(lockParsed);
  }

  return lockedVersions;
}

function getLockedDependencyVersions(
  obj: PnpmLockFile | Record<string, PnpmDependencySchema>,
): Record<string, Record<string, string>> {
  const dependencyTypes = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ] as const;

  const res: Record<string, Record<string, string>> = {};
  for (const depType of dependencyTypes) {
    res[depType] = {};
    for (const [pkgName, versionCarrier] of Object.entries(
      obj[depType] ?? {},
    )) {
      let version: string;
      if (is.object(versionCarrier)) {
        version = versionCarrier['version'];
      } else {
        version = versionCarrier;
      }

      const pkgVersion = version.split('(')[0].trim();
      res[depType][pkgName] = pkgVersion;
    }
  }

  return res;
}

export function extractPnpmWorkspaceFile(
  content: string,
  packageFile: string,
): PackageFile | null {
  logger.trace(`pnpm.extractPnpmWorkspaceFile(${packageFile})`);

  const pnpmCatalogs: PnpmCatalog[] = [];
  try {
    pnpmCatalogs.push(...parsePnpmCatalogs(content));
  } catch {
    logger.debug({ packageFile }, `Invalid pnpm workspace YAML.`);
    return null;
  }

  const extracted = extractPnpmCatalogDeps(pnpmCatalogs);

  if (!extracted) {
    return null;
  }

  return {
    ...extracted,
    packageFile,
  };
}

function extractPnpmCatalogDeps(
  catalogs: PnpmCatalog[],
): PackageFileContent<NpmManagerData> | null {
  const CATALOG_DEPENDENCY = 'pnpm.catalog';

  const deps: PackageDependency[] = [];

  for (const catalog of catalogs) {
    for (const [key, val] of Object.entries(catalog.dependencies)) {
      const depName = parseDepName(CATALOG_DEPENDENCY, key);
      let dep: PackageDependency = {
        depType: CATALOG_DEPENDENCY,
        // TODO(fpapado): for PR discussion, consider how users might be able to
        // match on specific catalogs for their config.
        //
        // For example, we could change depType to `pnpm.catalog.${string}`, so
        // that users can match use `{matchDepTypes: ["pnpm.catalog.default"]}`,
        // `{matchDepTypes: ["pnpm.catalog.react17"]}` and so on.
        //
        // Another option would be to mess with depName/packageName.
        //
        // Is there precedence for something similar?
        depName,
        managerData: {
          // We assign the name of the catalog, in order to know which fields to
          // update later on.
          catalogName: catalog.name,
        },
      };
      if (depName !== key) {
        dep.managerData!.key = key;
      }

      // TODO: fix type #22198
      dep = {
        ...dep,
        ...extractDependency(CATALOG_DEPENDENCY, depName, val!),
        prettyDepType: CATALOG_DEPENDENCY,
      };
      dep.prettyDepType = CATALOG_DEPENDENCY;
      deps.push(dep);
    }
  }

  return {
    deps,
  };
}

export const pnpmCatalogsSchema = z.object({
  catalog: z.optional(z.record(z.string())),
  catalogs: z.optional(z.record(z.record(z.string()))),
});

function parsePnpmCatalogs(content: string): PnpmCatalog[] {
  const { catalog: defaultCatalogDeps, catalogs: namedCatalogs } =
    parseSingleYaml(content, { customSchema: pnpmCatalogsSchema });

  const result = [
    {
      name: 'default',
      dependencies: defaultCatalogDeps ?? {},
    },
  ];

  if (!namedCatalogs) {
    return result;
  }

  for (const [name, dependencies] of Object.entries(namedCatalogs)) {
    result.push({
      name,
      dependencies,
    });
  }

  return result;
}
