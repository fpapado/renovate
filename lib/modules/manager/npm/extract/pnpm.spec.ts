import { codeBlock } from 'common-tags';
import { Fixtures } from '../../../../../test/fixtures';
import { fs, getFixturePath, logger, partial } from '../../../../../test/util';
import { GlobalConfig } from '../../../../config/global';
import * as yaml from '../../../../util/yaml';
import type { PackageFile } from '../../types';
import type { NpmManagerData } from '../types';
import {
  detectPnpmWorkspaces,
  extractPnpmFilters,
  extractPnpmWorkspaceFile,
  findPnpmWorkspace,
  getPnpmLock,
} from './pnpm';

jest.mock('../../../../util/fs');

describe('modules/manager/npm/extract/pnpm', () => {
  beforeAll(() => {
    GlobalConfig.set({ localDir: getFixturePath('pnpm-monorepo/', '..') });
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('.extractPnpmFilters()', () => {
    it('detects errors in pnpm-workspace.yml file structure', async () => {
      fs.readLocalFile.mockResolvedValueOnce('p!!!ckages:\n - "packages/*"');

      const workSpaceFilePath = getFixturePath(
        'pnpm-monorepo/pnpm-workspace.yml',
        '..',
      );
      const res = await extractPnpmFilters(workSpaceFilePath);
      expect(res).toBeUndefined();
      expect(logger.logger.trace).toHaveBeenCalledWith(
        {
          fileName: expect.any(String),
        },
        'Failed to find required "packages" array in pnpm-workspace.yaml',
      );
    });

    it('detects errors when opening pnpm-workspace.yml file', async () => {
      jest.spyOn(yaml, 'parseSingleYaml').mockImplementationOnce(() => {
        throw new Error();
      });

      const res = await extractPnpmFilters('pnpm-workspace.yml');
      expect(res).toBeUndefined();
      expect(logger.logger.trace).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: expect.any(String),
          err: expect.anything(),
        }),
        'Failed to parse pnpm-workspace.yaml',
      );
    });
  });

  describe('.findPnpmWorkspace()', () => {
    it('detects missing pnpm-workspace.yaml', async () => {
      fs.findLocalSiblingOrParent.mockResolvedValueOnce(null);

      const packageFile = 'package.json';
      const res = await findPnpmWorkspace(packageFile);
      expect(res).toBeNull();
      expect(logger.logger.trace).toHaveBeenCalledWith(
        expect.objectContaining({ packageFile }),
        'Failed to locate pnpm-workspace.yaml in a parent directory.',
      );
    });

    it('detects missing pnpm-lock.yaml when pnpm-workspace.yaml was already found', async () => {
      fs.findLocalSiblingOrParent.mockResolvedValueOnce('pnpm-workspace.yaml');
      fs.localPathExists.mockResolvedValueOnce(false);

      const packageFile = 'package.json';
      const res = await findPnpmWorkspace(packageFile);
      expect(res).toBeNull();
      expect(logger.logger.trace).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceYamlPath: 'pnpm-workspace.yaml',
          packageFile,
        }),
        'Failed to find a pnpm-lock.yaml sibling for the workspace.',
      );
    });
  });

  describe('.detectPnpmWorkspaces()', () => {
    beforeEach(() => {
      const realFs = jest.requireActual<typeof fs>('../../../../util/fs');

      // The real implementations of these functions are used for this block;
      // they do static path manipulation.
      fs.findLocalSiblingOrParent.mockImplementation(
        realFs.findLocalSiblingOrParent,
      );
      fs.getSiblingFileName.mockImplementation(realFs.getSiblingFileName);

      // Falls through to reading from the fixture path defined in GlobalConfig
      // at the top of this file
      fs.readLocalFile.mockImplementation(realFs.readLocalFile);
    });

    it('uses pnpm workspaces', async () => {
      fs.localPathExists.mockResolvedValue(true);
      const packageFiles = partial<PackageFile<NpmManagerData>>([
        {
          packageFile: 'package.json',
          managerData: { pnpmShrinkwrap: 'pnpm-lock.yaml' },
        },
        {
          packageFile: 'nested-packages/group/a/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/nested-group-a',
          },
        },
        {
          packageFile: 'nested-packages/group/b/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/nested-group-b',
          },
        },
        {
          packageFile: 'non-nested-packages/a/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/non-nested-a',
          },
        },
        {
          packageFile: 'non-nested-packages/b/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/non-nested-b',
          },
        },
        {
          packageFile: 'solo-package/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/solo',
          },
        },
        {
          packageFile: 'solo-package-leading-dot-slash/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/solo-leading-dot-slash',
          },
        },
        {
          packageFile: 'solo-package-leading-double-dot-slash/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/solo-leading-double-dot-slash',
          },
        },
        {
          packageFile: 'solo-package-trailing-slash/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/solo-trailing-slash',
          },
        },
        {
          packageFile: 'test/test-package/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/test-package',
          },
        },
        {
          packageFile: 'tests/test-package2/package.json',
          managerData: {
            pnpmShrinkwrap: undefined,
            packageJsonName: '@demo/test-package2',
          },
        },
      ]);

      await detectPnpmWorkspaces(packageFiles);
      expect(packageFiles).toMatchSnapshot();
      expect(
        packageFiles.every(
          (packageFile) =>
            packageFile.managerData?.pnpmShrinkwrap !== undefined,
        ),
      ).toBeTrue();
    });

    it('skips when pnpm shrinkwrap file has already been provided', async () => {
      const packageFiles = [
        {
          packageFile: 'package.json',
          managerData: { pnpmShrinkwrap: 'pnpm-lock.yaml' },
        },
      ];

      await detectPnpmWorkspaces(packageFiles);
      expect(packageFiles).toEqual([
        {
          packageFile: 'package.json',
          managerData: { pnpmShrinkwrap: 'pnpm-lock.yaml' },
        },
      ]);
    });

    it('filters none matching packages', async () => {
      fs.localPathExists.mockResolvedValue(true);
      const packageFiles = [
        {
          packageFile: 'package.json',
          managerData: { pnpmShrinkwrap: 'pnpm-lock.yaml' },
        },
        {
          packageFile: 'nested-packages/group/a/package.json',
          packageJsonName: '@demo/nested-group-a',
          managerData: { pnpmShrinkwrap: undefined },
        },
        {
          packageFile: 'not-matching/b/package.json',
          packageJsonName: '@not-matching/b',
          managerData: { pnpmShrinkwrap: undefined },
        },
      ];

      await detectPnpmWorkspaces(packageFiles);
      expect(packageFiles).toEqual([
        {
          packageFile: 'package.json',
          managerData: { pnpmShrinkwrap: 'pnpm-lock.yaml' },
        },
        {
          packageFile: 'nested-packages/group/a/package.json',
          packageJsonName: '@demo/nested-group-a',
          managerData: { pnpmShrinkwrap: 'pnpm-lock.yaml' },
        },
        {
          packageFile: 'not-matching/b/package.json',
          packageJsonName: '@not-matching/b',
          managerData: { pnpmShrinkwrap: undefined },
        },
      ]);
      expect(
        packageFiles.find(
          (packageFile) =>
            packageFile.packageFile === 'not-matching/b/package.json',
        )?.managerData.pnpmShrinkwrap,
      ).toBeUndefined();
    });
  });

  describe('.getPnpmLock()', () => {
    it('returns empty if failed to parse', async () => {
      fs.readLocalFile.mockResolvedValueOnce(undefined as never);
      const res = await getPnpmLock('package.json');
      expect(res.lockedVersionsWithPath).toBeUndefined();
    });

    it('extracts version from monorepo', async () => {
      const plocktest1Lock = Fixtures.get('pnpm-monorepo/pnpm-lock.yaml', '..');
      fs.readLocalFile.mockResolvedValueOnce(plocktest1Lock);
      const res = await getPnpmLock('package.json');
      expect(Object.keys(res.lockedVersionsWithPath!)).toHaveLength(11);
    });

    it('extracts version from normal repo', async () => {
      const plocktest1Lock = Fixtures.get(
        'lockfile-parsing/pnpm-lock.yaml',
        '..',
      );
      fs.readLocalFile.mockResolvedValueOnce(plocktest1Lock);
      const res = await getPnpmLock('package.json');
      expect(Object.keys(res.lockedVersionsWithPath!)).toHaveLength(1);
    });

    it('returns empty if no deps', async () => {
      fs.readLocalFile.mockResolvedValueOnce('{}');
      const res = await getPnpmLock('package.json');
      expect(res.lockedVersionsWithPath).toBeUndefined();
    });
  });

  describe('.extractPnpmWorkspaceFile()', () => {
    it('ignores invalid pnpm-workspace.yaml file', () => {
      expect(extractPnpmWorkspaceFile('', 'pnpm-workspace.yaml')).toBeNull();
    });

    it('handles empty catalog entries', () => {
      expect(
        extractPnpmWorkspaceFile(
          codeBlock`
            catalog:
            catalogs:
          `,
          'pnpm-workspace.yaml',
        ),
      ).toBeNull();
    });

    it('parses valid pnpm-workspace.yaml file', () => {
      expect(
        extractPnpmWorkspaceFile(
          codeBlock`
            catalog:
              react: 18.3.0

            catalogs:
              react17:
                react: 17.0.2
          `,
          'pnpm-workspace.yaml',
        ),
      ).toMatchObject({
        deps: [
          {
            currentValue: '18.3.0',
            datasource: 'npm',
            depName: 'react',
            depType: 'pnpm.catalog.default',
            prettyDepType: 'pnpm.catalog.default',
            managerData: {
              catalogName: 'default',
            },
          },
          {
            currentValue: '17.0.2',
            datasource: 'npm',
            depName: 'react',
            depType: 'pnpm.catalog.react17',
            prettyDepType: 'pnpm.catalog.react17',
            managerData: {
              catalogName: 'react17',
            },
          },
        ],
        packageFile: 'pnpm-workspace.yaml',
      });
    });
  });
});
