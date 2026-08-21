import { renderRecruiterTemplate } from './recruiter-template.mjs';
import { renderReplyTemplate } from './reply-template.mjs';

export const fakeProvider = Object.freeze({
  async generate(input) {
    if (!Array.isArray(input?.evidence) || input.evidence.length === 0) {
      throw codedError('BLOCKED_NO_SELECTED_EVIDENCE');
    }
    if (input.objective === 'draft_email_reply') {
      return {
        schemaVersion: 'path.brain.output.v1',
        provider: 'fake',
        model: 'deterministic-reply-template-v1',
        promptVersion: input.promptVersion,
        ...renderReplyTemplate(input)
      };
    }
    return {
      schemaVersion: 'path.brain.output.v1',
      provider: 'fake',
      model: 'deterministic-recruiter-template-v1',
      promptVersion: input.promptVersion,
      ...renderRecruiterTemplate(input)
    };
  }
});

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
