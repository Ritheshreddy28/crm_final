import { BACKEND_ENV, VISION_CHAT_URLS } from './backendConfig';

/**
 * AI Vision extraction for payment screenshots.
 * Uses OpenAI-compatible vision API; falls back to OCR in caller if this fails.
 * Backend URLs: see VISION_CHAT_URLS in ./backendConfig.ts
 */
const VISION_PROMPT = `You are an AI system that extracts payment details from a mobile payment screenshot.
Analyze the image and return ONLY valid JSON.
Do not include explanations or extra text.

Extract the following fields if visible:
- amount (with currency, e.g. "210 INR")
- payment_date (YYYY-MM-DD)
- payer_name: the name of the person/bank who sent the payment (often labeled "Banking name", "Payer", "From", "Sender" in the screenshot)
- receiver_name: the recipient or bank holder who received the payment; only if clearly visible—if not in the screenshot, return null
- payment_method (UPI, Card, Bank Transfer, Wallet, etc.)
- utr: the UTR / transaction reference number (not "transaction ID"—use the UTR or reference number shown)
- payment_status (Success / Failed / Pending)

Rules:
- If a field is not visible, return null
- Normalize dates to ISO format (YYYY-MM-DD)
- Prefer values explicitly shown in the screenshot
- Do not guess or hallucinate; leave receiver_name null if it is not shown
- For payer, use the value shown as "Banking name" or payer/sender when present

JSON format:
{
  "amount": string | null,
  "payment_date": string | null,
  "payer_name": string | null,
  "receiver_name": string | null,
  "payment_method": string | null,
  "utr": string | null,
  "payment_status": string | null
}`;

export interface VisionPaymentData {
  amount: string | null;
  payment_date: string | null;
  payer_name: string | null;
  receiver_name: string | null;
  payment_method: string | null;
  utr: string | null;
  payment_status: string | null;
}

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

function isValidPaymentDate(s: string | null): s is string {
  return typeof s === 'string' && s.length === 10 && YYYY_MM_DD.test(s);
}

function parseJsonFromContent(content: string): VisionPaymentData | null {
  const trimmed = content.trim();
  const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonBlock ? jsonBlock[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    return {
      amount: typeof o.amount === 'string' ? o.amount : o.amount === null ? null : null,
      payment_date: typeof o.payment_date === 'string' ? o.payment_date : o.payment_date === null ? null : null,
      payer_name: typeof o.payer_name === 'string' ? o.payer_name : o.payer_name === null ? null : null,
      receiver_name: typeof o.receiver_name === 'string' ? o.receiver_name : o.receiver_name === null ? null : null,
      payment_method: typeof o.payment_method === 'string' ? o.payment_method : o.payment_method === null ? null : null,
      utr: typeof o.utr === 'string' ? o.utr : o.utr === null ? null : (typeof (o as Record<string, unknown>).transaction_id === 'string' ? (o as Record<string, unknown>).transaction_id as string : null),
      payment_status: typeof o.payment_status === 'string' ? o.payment_status : o.payment_status === null ? null : null,
    };
  } catch {
    return null;
  }
}

/**
 * Send image to AI vision model and return parsed payment data, or null on failure.
 * Requires VITE_OPENAI_API_KEY to be set.
 */
export async function extractPaymentDetailsFromVision(imageFile: File): Promise<VisionPaymentData | null> {
  const apiKey = BACKEND_ENV.openAiApiKey;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    return null;
  }

  const isOpenRouter = apiKey.startsWith('sk-or-v1-');
  const url = isOpenRouter ? VISION_CHAT_URLS.openRouter : VISION_CHAT_URLS.openai;
  const model = isOpenRouter ? 'openai/gpt-4o' : 'gpt-4o';

  return new Promise<VisionPaymentData | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      (async () => {
        try {
          const dataUrl = reader.result as string;
          const base64 = dataUrl?.toString().split(',')[1];
          if (!base64) {
            resolve(null);
            return;
          }
          const mime = imageFile.type || 'image/jpeg';

          const body = {
            model,
            max_tokens: 500,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: VISION_PROMPT },
                  {
                    type: 'image_url',
                    image_url: { url: `data:${mime};base64,${base64}` },
                  },
                ],
              },
            ],
          };

          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            resolve(null);
            return;
          }

          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') {
            resolve(null);
            return;
          }

          const parsed = parseJsonFromContent(content);
          resolve(parsed ?? null);
        } catch {
          resolve(null);
        }
      })();
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(imageFile);
  });
}

/**
 * Normalize vision result for form: ensure payment_date is YYYY-MM-DD or null.
 */
export function validateVisionResult(data: VisionPaymentData): VisionPaymentData {
  return {
    ...data,
    payment_date: data.payment_date && isValidPaymentDate(data.payment_date) ? data.payment_date : null,
  };
}
