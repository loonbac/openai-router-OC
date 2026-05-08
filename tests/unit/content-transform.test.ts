import {
  mapContentToCodex,
  contentToString,
  looksLikeOpenAIContentArray,
  type OpenAIContentPart,
  type CodexContentItem,
} from '../../src/content-transform'

describe('mapContentToCodex', () => {
  describe('string content', () => {
    test('user string maps to input_text', () => {
      const result = mapContentToCodex('hello', 'user')
      expect(result).toEqual([{ type: 'input_text', text: 'hello' }])
    })

    test('assistant string maps to output_text', () => {
      const result = mapContentToCodex('Hello!', 'assistant')
      expect(result).toEqual([{ type: 'output_text', text: 'Hello!' }])
    })
  })

  describe('user array content', () => {
    test('text-only array maps to input_text parts', () => {
      const content: OpenAIContentPart[] = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]
      const result = mapContentToCodex(content, 'user')
      expect(result).toEqual([
        { type: 'input_text', text: 'hello' },
        { type: 'input_text', text: 'world' },
      ])
    })

    test('text+image array preserves order', () => {
      const content: OpenAIContentPart[] = [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ]
      const result = mapContentToCodex(content, 'user')
      expect(result).toEqual([
        { type: 'input_text', text: 'what is this' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' },
      ])
    })

    test('image-only array maps to input_image', () => {
      const content: OpenAIContentPart[] = [
        { type: 'image_url', image_url: { url: 'https://example.com/pic.jpg' } },
      ]
      const result = mapContentToCodex(content, 'user')
      expect(result).toEqual([
        { type: 'input_image', image_url: 'https://example.com/pic.jpg', detail: 'auto' },
      ])
    })

    test('drops unknown part types', () => {
      const content: OpenAIContentPart[] = [
        { type: 'text', text: 'keep' },
        { type: 'unknown', text: 'drop' } as any,
      ]
      const result = mapContentToCodex(content, 'user')
      expect(result).toEqual([{ type: 'input_text', text: 'keep' }])
    })
  })

  describe('assistant array content', () => {
    test('text-only array maps to output_text', () => {
      const content: OpenAIContentPart[] = [{ type: 'text', text: 'Sure!' }]
      const result = mapContentToCodex(content, 'assistant')
      expect(result).toEqual([{ type: 'output_text', text: 'Sure!' }])
    })

    test('image parts are safely dropped', () => {
      const content: OpenAIContentPart[] = [
        { type: 'text', text: 'result: ' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ]
      const result = mapContentToCodex(content, 'assistant')
      expect(result).toEqual([{ type: 'output_text', text: 'result: ' }])
    })

    test('image-only array yields empty content array', () => {
      const content: OpenAIContentPart[] = [
        { type: 'image_url', image_url: { url: 'data:...' } },
      ]
      const result = mapContentToCodex(content, 'assistant')
      expect(result).toEqual([])
    })
  })

  describe('safety', () => {
    test('never produces text field with an array value', () => {
      const content: OpenAIContentPart[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]
      const result = mapContentToCodex(content, 'user')
      for (const item of result) {
        if ('text' in item) {
          expect(typeof item.text).toBe('string')
        }
      }
      expect(result).toHaveLength(2)
    })

    test('normalizes nested text arrays into strings', () => {
      const content: OpenAIContentPart[] = [
        { type: 'text', text: ['hello', ' ', 'world'] as any },
      ]
      const result = mapContentToCodex(content, 'user')
      expect(result).toEqual([{ type: 'input_text', text: 'hello world' }])
    })

    test('normalizes codex-style output_text parts with array text payloads', () => {
      const content: OpenAIContentPart[] = [
        { type: 'output_text', text: ['a', 'b'] as any },
      ]
      const result = mapContentToCodex(content, 'assistant')
      expect(result).toEqual([{ type: 'output_text', text: 'ab' }])
    })
  })
})

describe('contentToString', () => {
  test('string passthrough', () => {
    expect(contentToString('hello')).toBe('hello')
  })

  test('text-part concatenation', () => {
    const content: OpenAIContentPart[] = [
      { type: 'text', text: 'You are' },
      { type: 'text', text: ' helpful' },
    ]
    expect(contentToString(content)).toBe('You are helpful')
  })

  test('non-text parts are skipped', () => {
    const content: OpenAIContentPart[] = [
      { type: 'text', text: 'Be concise.' },
      { type: 'image_url', image_url: { url: 'x' } },
    ]
    expect(contentToString(content)).toBe('Be concise.')
  })

  test('empty array yields empty string', () => {
    expect(contentToString([])).toBe('')
  })

  test('nested arrays are flattened into a string', () => {
    expect(contentToString(['x', ['y', 'z']] as any)).toBe('xyz')
  })
})

describe('looksLikeOpenAIContentArray', () => {
  test('returns true for OpenAI text parts', () => {
    expect(looksLikeOpenAIContentArray([{ type: 'text', text: 'hi' }])).toBe(true)
  })

  test('returns true for OpenAI image parts', () => {
    expect(looksLikeOpenAIContentArray([{ type: 'image_url', image_url: { url: 'x' } }])).toBe(true)
  })

  test('returns true for Codex parts too', () => {
    expect(looksLikeOpenAIContentArray([{ type: 'input_text', text: 'hi' }])).toBe(true)
  })

  test('returns false for string', () => {
    expect(looksLikeOpenAIContentArray('hi')).toBe(false)
  })

  test('returns false for empty array', () => {
    expect(looksLikeOpenAIContentArray([])).toBe(false)
  })
})
