import { describe, expect, it } from 'vitest';
import { formatEmailBody } from './format-body';

describe('formatEmailBody', () => {
  it('collapses markdown-style image refs to filename', () => {
    const input =
      'Header\n[https://files.manuscdn.com/edm/20250410/d7901242aa9cdbd082711ab4b235b8fd.png]\nFooter';
    const out = formatEmailBody(input);
    expect(out).toContain('[image: d7901242aa9cdbd082711ab4b235b8fd.png]');
    expect(out).not.toContain('manuscdn.com');
  });

  it('collapses long tracking URLs to [link: hostname]', () => {
    const longUrl =
      'https://email.mail.manus.im/c/eJwozjtuwzAMANDTSFsMmtaHHjhkMdqhQ09QSJQCE7DlllbSHr_IoP0Nr3AIAH6ylccYYwjovLMrg9wkFZpjhlRIRoqBsPpEPhPG7KwyAgbwMI4zxMkNfiokJAg4OwTvjYM96TbsqT3OQXe78dr792mmq8HF4PI7yLEbX9fZp71weZ9dmHKz1frQt5VObvKDt_FNzqc9LO7reVFLX013';
    const out = formatEmailBody(`See ${longUrl} for details`);
    expect(out).toBe('See [link: email.mail.manus.im] for details');
  });

  it('preserves short URLs as-is', () => {
    const input = 'Visit https://heronlabs.com today';
    expect(formatEmailBody(input)).toBe(input);
  });

  it('collapses 3+ blank lines to a single blank line', () => {
    const input = 'A\n\n\n\n\nB';
    expect(formatEmailBody(input)).toBe('A\n\nB');
  });

  it('handles real customer email content unchanged', () => {
    const input =
      'Hi Heron team,\n\nLooking to reorder 200 cases for May 15 delivery.\n\nThanks,\nEric';
    expect(formatEmailBody(input)).toBe(input);
  });
});
