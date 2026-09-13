import { describe, expect, it } from 'bun:test';
import { unsupportedPronouns } from '../scripts/extract-hn-profiles/hn-screen-pronouns.mjs';

// The extractor is instructed not to gender a candidate the text never gendered, and the trial
// batch that prompted that instruction had it wrong four times out of four. This is the check
// that the instruction is still holding, so these cases are the ones that actually shipped.
describe('unsupportedPronouns', () => {
  it('catches a pronoun invented from a name alone', () => {
    const summary = 'Markus Hütter is a senior architect. He specializes in C#/.NET.';
    const source = 'Senior software architect. I specialize in C#/.NET. Available immediately.';
    expect(unsupportedPronouns(summary, source)).toEqual(['he']);
  });

  it('allows a pronoun the candidate used of themselves', () => {
    const summary = 'She founded the team and led it for six years.';
    const source = 'I founded the team (she/her) and led it for six years.';
    expect(unsupportedPronouns(summary, source)).toEqual([]);
  });

  it('passes a summary that writes around the pronoun', () => {
    const summary = 'A backend engineer with ten years building compilers in C from scratch.';
    const source = 'I have ten years of experience and I build compilers in C from scratch.';
    expect(unsupportedPronouns(summary, source)).toEqual([]);
  });

  it('reports every distinct unsupported form, once each', () => {
    const summary = 'He led the team. His work shipped. He then left.';
    expect(unsupportedPronouns(summary, 'I led the team and my work shipped.')).toEqual(['he', 'his']);
  });

  it('does not match a pronoun inside a longer word', () => {
    // "the", "here", "usher", "shell" all contain a pronoun as a substring.
    const summary = 'Ships the shell here; a usher of releases at Hershey.';
    expect(unsupportedPronouns(summary, 'I ship shells.')).toEqual([]);
  });

  it('is case-insensitive on both sides', () => {
    expect(unsupportedPronouns('HE writes Go.', 'I write Go. He/him.')).toEqual([]);
  });
});
