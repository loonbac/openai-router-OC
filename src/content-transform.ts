export interface OpenAIContentPart {
  type: string
  text?: unknown
  image_url?: string | { url: string }
}

export interface CodexContentItem {
  type: string
  text?: string
  image_url?: string
  detail?: string
}

function normalizeTextValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => normalizeTextValue(part))
      .filter(Boolean)
      .join('')
  }
  if (value && typeof value === 'object') {
    if ('text' in value) return normalizeTextValue((value as { text?: unknown }).text)
    if ('value' in value) return normalizeTextValue((value as { value?: unknown }).value)
  }
  return ''
}

function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (
    value &&
    typeof value === 'object' &&
    'url' in value &&
    typeof (value as { url?: unknown }).url === 'string'
  ) {
    return (value as { url: string }).url
  }
  return undefined
}

export function mapContentToCodex(
  content: string | Array<OpenAIContentPart>,
  role: string
): Array<CodexContentItem> {
  if (typeof content === 'string') {
    return [
      {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: content,
      },
    ]
  }

  if (!Array.isArray(content)) {
    return []
  }

  const result: Array<CodexContentItem> = []

  for (const part of content) {
    if (!part || typeof part !== 'object') continue

    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      const text = normalizeTextValue(part.text)
      if (!text) continue
      result.push({
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text,
      })
    } else if (
      part.type === 'image_url' ||
      part.type === 'input_image'
    ) {
      const imageUrl = normalizeImageUrl(part.image_url)
      if (!imageUrl) continue
      if (role !== 'assistant') {
        result.push({
          type: 'input_image',
          image_url: imageUrl,
          detail: 'auto',
        })
      }
    }
  }

  return result
}

export function looksLikeOpenAIContentArray(content: unknown): content is Array<OpenAIContentPart> {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part &&
        typeof part === 'object' &&
        (
          part.type === 'text' ||
          part.type === 'image_url' ||
          part.type === 'input_text' ||
          part.type === 'output_text' ||
          part.type === 'input_image'
        )
    )
  )
}

export function contentToString(
  content: string | Array<OpenAIContentPart>,
  _label?: string
): string {
  return normalizeTextValue(content)
}
