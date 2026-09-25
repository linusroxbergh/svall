const ADJECTIVES = [
  'amber', 'ancient', 'blue', 'bold', 'brave', 'brisk', 'calm', 'clever', 'cold', 'copper',
  'crisp', 'dark', 'deep', 'dry', 'eager', 'early', 'fair', 'fast', 'fine', 'gentle',
  'glad', 'golden', 'grand', 'green', 'grey', 'hard', 'hazy', 'idle', 'iron', 'keen',
  'late', 'lean', 'light', 'lively', 'lone', 'loud', 'low', 'lucky', 'mild', 'neat',
  'odd', 'old', 'pale', 'plain', 'proud', 'quick', 'quiet', 'rapid', 'red', 'rough',
  'round', 'royal', 'salty', 'sharp', 'short', 'shy', 'silver', 'slow', 'small', 'smooth',
  'soft', 'solid', 'spare', 'steady', 'still', 'stout', 'sunny', 'swift', 'tall', 'tame',
  'tidy', 'tiny', 'true', 'warm', 'wild', 'wise',
];

const NOUNS = [
  'acorn', 'anchor', 'ash', 'badger', 'basil', 'bay', 'beacon', 'bear', 'birch', 'bison',
  'brook', 'cedar', 'cliff', 'clover', 'coast', 'corn', 'crane', 'creek', 'crow', 'dawn',
  'deer', 'delta', 'dune', 'eagle', 'elm', 'ember', 'falcon', 'fern', 'ferry', 'field',
  'finch', 'fjord', 'flint', 'fog', 'fox', 'frog', 'grove', 'gull', 'harbor', 'hawk',
  'heron', 'hill', 'ivy', 'kelp', 'lake', 'lark', 'ledge', 'lynx', 'maple', 'marsh',
  'meadow', 'mist', 'moose', 'moss', 'oak', 'otter', 'owl', 'peak', 'pearl', 'pine',
  'plum', 'quail', 'raven', 'reef', 'ridge', 'river', 'robin', 'sage', 'seal', 'shore',
  'sparrow', 'spruce', 'stone', 'stork', 'swan', 'thorn', 'tide', 'trout', 'wave', 'wren',
];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

const ADJECTIVE_SET = new Set(ADJECTIVES);
const NOUN_SET = new Set(NOUNS);

// a name randomName could have given, which says nothing about the work
export function isGeneratedName(name: string): boolean {
  const words = name.split(' ');
  return words.length === 2 && ADJECTIVE_SET.has(words[0]) && NOUN_SET.has(words[1]);
}

export function randomName(taken: ReadonlySet<string> = new Set()): string {
  let name = '';
  for (let i = 0; i < 20; i++) {
    name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (!taken.has(name)) break;
  }
  return name;
}
