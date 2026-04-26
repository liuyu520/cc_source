import { describe, expect, test } from 'bun:test'
import {
  isStreamingNotSupportedError,
  StreamingNotSupportedError,
} from './errors.js'

describe('isStreamingNotSupportedError', () => {
  test('detects Bedrock InvokeModelWithResponseStream 400 rejection', () => {
    const err = new Error(
      'InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: 51b18594-169c-49c3-ac93-3323ff96a563, ValidationException: Operation not allowed',
    )

    expect(isStreamingNotSupportedError(err)).toBe(true)
  })

  test('detects explicit StreamingNotSupportedError', () => {
    expect(
      isStreamingNotSupportedError(
        new StreamingNotSupportedError('stream disabled'),
      ),
    ).toBe(true)
  })

  test('does not misclassify generic 400 bad requests', () => {
    const err = new Error(
      'API Error: 400 {"error":{"message":"invalid tool input"}}',
    )

    expect(isStreamingNotSupportedError(err)).toBe(false)
  })
})
