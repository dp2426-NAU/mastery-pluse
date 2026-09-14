const { jaccardSimilarity, isComparable, SIMILARITY_THRESHOLD } = require('../server/similarity');

describe('jaccardSimilarity', () => {
  test('identical text scores 1', () => {
    const text = 'The firewall should deny all inbound traffic by default and log every dropped packet.';
    expect(jaccardSimilarity(text, text)).toBe(1);
  });

  test('two answers copy-pasted from the same source score above the threshold', () => {
    const a = 'Phishing tricks a user into revealing credentials via a fake but convincing email or website that impersonates a trusted sender.';
    const b = 'Phishing tricks a user into revealing credentials via a fake but convincing email or website impersonating a trusted sender, often urgently.';
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  test('two independent, differently-worded answers on the same topic score low', () => {
    const a = 'I would rotate the exposed API keys immediately, then review access logs for unauthorized calls before restoring service.';
    const b = 'First patch the vulnerable dependency, redeploy behind a WAF, and notify affected customers per the incident response plan.';
    expect(jaccardSimilarity(a, b)).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  test('completely unrelated text scores near 0', () => {
    expect(jaccardSimilarity('Subnet masks divide a network into smaller segments.', 'Bake the bread at 220 degrees for twenty five minutes.')).toBeLessThan(0.1);
  });

  test('empty or missing text never throws and scores 0', () => {
    expect(jaccardSimilarity('', 'something with real content here')).toBe(0);
    expect(jaccardSimilarity(null, undefined)).toBe(0);
  });

  test('is symmetric', () => {
    const a = 'Least privilege means granting only the access a task actually requires.';
    const b = 'Granting only the access a task actually requires is the idea behind least privilege.';
    expect(jaccardSimilarity(a, b)).toBeCloseTo(jaccardSimilarity(b, a), 10);
  });
});

describe('isComparable', () => {
  test('rejects very short answers -- too easy to overlap by chance', () => {
    expect(isComparable('MFA prevents it.')).toBe(false);
  });

  test('accepts a real short-answer-length response', () => {
    expect(isComparable('The principle of least privilege limits the blast radius of a compromised account by restricting what it can access.')).toBe(true);
  });
});
