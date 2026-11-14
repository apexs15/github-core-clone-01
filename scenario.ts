// The token's owner, derived from the contest's fixed scenario seed.
//
// The suite's checks name one login as the token owner (the scenario viewer) and another as a
// stranger with no rights on the viewer's repositories. Both logins come from wire.ts's one fixed
// seed (SCENARIO_SEED) through a pure generator, so the forge can compute them itself instead of
// guessing: the same seed, the same names, in any process. This file re-implements exactly the
// generator the kit ships (fnv1a64, mix64, the xorshift64* Rng, generateUsers) and nothing else —
// no clock, no randomness, no network.
//
// The viewer this yields is `adaiversen` (id 1000); the teammate is `quinnkeller`, the stranger
// `olgabauer`. Those are the logins the checks use, so the forge answers GET /user and
// GET /api/v3/user with the viewer's login and treats any other owner in a path as foreign (404).

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const U64_MASK = 0xffffffffffffffffn;
/** The scenario's day one, 2025-01-01T00:00:00Z: every generated timestamp is this plus an offset. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a, 64-bit: a label's stable seed contribution. */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer. */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from. */
export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** `count` users with unique logins, deterministic for `rng`. */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export interface ScenarioIdentity {
  readonly viewer: ScenarioUser;
  readonly teammate: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly users: readonly ScenarioUser[];
}

let cached: ScenarioIdentity | null = null;

/** The scenario's users, computed once from the fixed seed. */
export function scenarioIdentity(): ScenarioIdentity {
  if (cached !== null) return cached;
  const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
  cached = {
    viewer: users[0] as ScenarioUser,
    teammate: users[1] as ScenarioUser,
    stranger: users[2] as ScenarioUser,
    users,
  };
  return cached;
}
