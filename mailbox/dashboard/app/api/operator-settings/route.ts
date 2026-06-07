import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { getOperatorSettings, updateOperatorSettings } from '@/lib/queries-operator-settings';
import { operatorSettingsUpdateSchema } from '@/lib/schemas/operator-settings';

// MBOX-162 P4 — operator workspace settings (basic_auth gated by Caddy; not
// under /api/internal). Backs the queue right pane's Calendar/Drive embeds and
// the /settings/workspace page. Singleton row (mailbox.operator_settings).
//
// GET /api/operator-settings → { settings: OperatorSettings }
// PUT /api/operator-settings → { settings: OperatorSettings }  (full replace)

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const settings = await getOperatorSettings();
    return NextResponse.json({ settings });
  } catch (error) {
    console.error('GET /api/operator-settings failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, operatorSettingsUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const settings = await updateOperatorSettings({
      booking_link: parsed.data.booking_link,
      calendar_embed_src: parsed.data.calendar_embed_src,
      drive_folder_id: parsed.data.drive_folder_id,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    console.error('PUT /api/operator-settings failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
