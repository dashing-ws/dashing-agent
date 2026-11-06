import { describe, it, expect } from 'vitest';
import { parseGrants, parseRepo, findGrant, starterGrantsFile } from './grants.js';

describe('parseRepo', () => {
  it('reads owner/name in the ways people write it', () => {
    expect(parseRepo('strokine/dashing-crypto-api')).toEqual({ owner: 'strokine', name: 'dashing-crypto-api' });
    expect(parseRepo(' `strokine/dashing-crypto-api` ')).toEqual({ owner: 'strokine', name: 'dashing-crypto-api' });
    expect(parseRepo('https://github.com/strokine/dashing-crypto-api')).toEqual({ owner: 'strokine', name: 'dashing-crypto-api' });
    expect(parseRepo('https://github.com/strokine/dashing-crypto-api.git')).toEqual({ owner: 'strokine', name: 'dashing-crypto-api' });
    expect(parseRepo('[strokine/x](https://github.com/strokine/x)')).toEqual({ owner: 'strokine', name: 'x' });
    expect(parseRepo('dashing-crypto-api')).toBeUndefined();
    expect(parseRepo('a/b/c')).toBeUndefined();
    expect(parseRepo('')).toBeUndefined();
  });
});

describe('parseGrants', () => {
  it('reads the table rows and ignores the rest of the file', () => {
    const text = [
      '# Repositories', '', 'Some words.', '',
      '| Repository | Granted | Task | What it is |',
      '| --- | --- | --- | --- |',
      '| strokine/dashing-crypto-api | 2026-11-06 | #7 | The API, Spring Boot 3.3, Gradle |',
      '| [strokine/dashing-crypto-web](https://github.com/strokine/dashing-crypto-web) | 2026-11-06 | 7 | The web app |',
      '| strokine/bare | | | |',
      '',
    ].join('\n');
    const { grants, problems } = parseGrants(text);
    expect(problems).toEqual([]);
    expect(grants).toEqual([
      { repo: 'strokine/dashing-crypto-api', owner: 'strokine', name: 'dashing-crypto-api', granted: '2026-11-06', task: 7, note: 'The API, Spring Boot 3.3, Gradle' },
      { repo: 'strokine/dashing-crypto-web', owner: 'strokine', name: 'dashing-crypto-web', granted: '2026-11-06', task: 7, note: 'The web app' },
      { repo: 'strokine/bare', owner: 'strokine', name: 'bare' },
    ]);
  });

  it('reports rows that do not name a repository and repeated ones', () => {
    const text = '| Repository | Granted |\n| --- | --- |\n| not a repo | x |\n| a/b | 1 |\n| A/B | 2 |\n';
    const { grants, problems } = parseGrants(text);
    expect(grants.map((g) => g.repo)).toEqual(['a/b']);
    expect(problems).toEqual(['row "not a repo" does not name a repository as owner/name', 'A/B is listed twice']);
  });

  it('starts empty from the starter file', () => {
    expect(parseGrants(starterGrantsFile())).toEqual({ grants: [], problems: [] });
  });

  it('finds a grant whatever the case', () => {
    const { grants } = parseGrants('| a/b | | | |\n');
    expect(findGrant(grants, 'A/B')?.repo).toBe('a/b');
    expect(findGrant(grants, 'a/c')).toBeUndefined();
  });
});
