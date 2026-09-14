// Explainable, deterministic text similarity for catching collusion on
// free-text answers -- no external API, no ML black box, no unreliable
// "this looks AI-written" claim. Word-set Jaccard similarity: how much of
// the vocabulary two answers share, independent of word order or length.
//
// This is deliberately NOT an AI-authorship detector. Those (Turnitin,
// GPTZero, etc.) are paid third-party services that still produce real
// false accusations against genuine student writing -- not something a
// from-scratch course project should fake. Comparing two students'
// answers against each other is honest, explainable, and catches the
// thing that actually matters: two people submitting the same text.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'it', 'this', 'that',
  'you', 'your', 'i', 'my', 'we', 'our', 'they', 'their', 'not', 'so', 'if',
]);

function wordSet(text) {
  const words = (text || '').toLowerCase().match(/[a-z0-9']+/g) || [];
  return new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

function jaccardSimilarity(textA, textB) {
  const a = wordSet(textA);
  const b = wordSet(textB);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Below this many meaningful words, overlap is too easy to hit by chance
// (e.g. two one-sentence answers both mentioning "firewall" and "patch").
const MIN_WORDS_TO_COMPARE = 6;
// 0.6 = 60% of each answer's meaningful vocabulary shared -- well above
// what two people independently paraphrasing the same concept produce.
const SIMILARITY_THRESHOLD = 0.6;

function isComparable(text) {
  return wordSet(text).size >= MIN_WORDS_TO_COMPARE;
}

module.exports = { jaccardSimilarity, isComparable, SIMILARITY_THRESHOLD, MIN_WORDS_TO_COMPARE, wordSet };
