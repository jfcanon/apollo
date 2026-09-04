import { describe, expect, it } from 'bun:test';

import { buildApolloSoulPrompt, buildInstalledToolPromptNote } from '@/persona/soul';

describe('apollo soul prompt', () => {
  it('always includes Apollo identity and essential tools base', () => {
    const soulPrompt = buildApolloSoulPrompt('default');
    expect(soulPrompt).toContain('You are Jarvis');
    expect(soulPrompt).toContain('timon_create_task');
    expect(soulPrompt).toContain('remember_fact');
    expect(soulPrompt).toContain('recall_memory');
    expect(soulPrompt).toContain('set_reminder');
    expect(soulPrompt).toContain('list_reminders');
    expect(soulPrompt).toContain('cancel_reminder');
    expect(soulPrompt).toContain('set_timer');
    expect(soulPrompt).toContain('start_pomodoro');
    expect(soulPrompt).not.toContain('gmail');
    expect(soulPrompt).not.toContain('web_search');
    expect(soulPrompt).not.toContain('start_research');
  });

  it('includes nerd technical register', () => {
    expect(buildApolloSoulPrompt('nerd')).toContain('Modo nerd');
    expect(buildApolloSoulPrompt('nerd')).toContain('técnico');
  });

  it('includes playful slang guidance', () => {
    const soulPrompt = buildApolloSoulPrompt('playful');
    expect(soulPrompt).toContain('Modo playful');
    expect(soulPrompt).toContain('boludo');
    expect(soulPrompt).toContain('nunca humilles');
  });

  it('includes warm closeness guidance', () => {
    expect(buildApolloSoulPrompt('warm')).toContain('Modo warm');
  });
});

describe('installed tool prompt note', () => {
  it('says nothing when the owner has connected no tools', () => {
    expect(buildInstalledToolPromptNote([])).toBe('');
  });

  it('names every connected tool so the model can find it', () => {
    const promptNote = buildInstalledToolPromptNote([
      'mcp_github_list_issues',
      'mcp_linear_list_teams',
    ]);
    expect(promptNote).toContain('mcp_github_list_issues');
    expect(promptNote).toContain('mcp_linear_list_teams');
  });
});

describe('dialogue posture', () => {
  it('tells the model to converse rather than interview, since the phone keeps the mic open', () => {
    const prompt = buildApolloSoulPrompt('default');
    expect(prompt).toContain('conversation, not an interview');
    // The listen marker still has to survive: turn/run.ts parses it literally.
    expect(prompt).toContain('[[escucho]]');
  });
});
