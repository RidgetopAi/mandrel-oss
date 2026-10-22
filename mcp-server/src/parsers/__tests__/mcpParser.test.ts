/**
 * TR001-5: Comprehensive MCP Parser Tests
 * Exhaustive unit tests ensuring crash-free operation
 */

import { McpParser } from '../mcpParser';

describe('McpParser', () => {
  describe('parseResponse', () => {
    it('should parse valid tool response', () => {
      const validResponse = JSON.stringify({
        content: [
          {
            type: 'text',
            text: 'Hello from AIDIS!'
          }
        ]
      });

      const result = McpParser.parseResponse(validResponse);
      expect(result.success).toBe(true);
      if (result.success) {
        expect('content' in result.data).toBe(true);
        expect((result.data as any).content).toHaveLength(1);
        expect((result.data as any).content[0].type).toBe('text');
      }
    });

    it('should parse valid success response', () => {
      const validResponse = JSON.stringify({
        success: true,
        data: { message: 'Operation completed' }
      });

      const result = McpParser.parseResponse(validResponse);
      expect(result.success).toBe(true);
      if (result.success) {
        expect('success' in result.data).toBe(true);
        expect((result.data as any).success).toBe(true);
      }
    });

    it('should parse valid error response', () => {
      const validResponse = JSON.stringify({
        success: false,
        error: 'Something went wrong'
      });

      const result = McpParser.parseResponse(validResponse);
      expect(result.success).toBe(true);
      if (result.success) {
        expect('success' in result.data).toBe(true);
        expect((result.data as any).success).toBe(false);
      }
    });

    it('should reject malformed JSON', () => {
      const malformedJson = '{ "content": [{ "type": "text", "text": "unclosed string }';
      const result = McpParser.parseResponse(malformedJson);
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('JSON parsing failed');
    });

    it('should reject empty response', () => {
      const result = McpParser.parseResponse('');
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Empty response');
    });

    it('should reject oversized response', () => {
      const oversized = JSON.stringify({
        content: [{
          type: 'text',
          text: 'x'.repeat(11 * 1024 * 1024) // 11MB
        }]
      });

      const result = McpParser.parseResponse(oversized);
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Response too large');
    });

    it('should reject deeply nested objects', () => {
      let deepObject: any = { content: [{ type: 'text', text: 'test' }] };
      for (let i = 0; i < 15; i++) {
        deepObject = { nested: deepObject };
      }

      const result = McpParser.parseResponse(JSON.stringify(deepObject));
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('nesting too deep');
    });

    it('should reject too many content items', () => {
      const tooManyItems = {
        content: Array.from({ length: 101 }, (_, i) => ({
          type: 'text',
          text: `Item ${i}`
        }))
      };

      const result = McpParser.parseResponse(JSON.stringify(tooManyItems));
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Too many content items');
    });

    it('should handle complex valid responses', () => {
      const complexResponse = {
        content: [
          {
            type: 'text',
            text: 'Multiple content types test'
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///path/to/file.txt',
              name: 'test file',
              description: 'A test file'
            }
          },
          {
            type: 'image',
            data: 'base64encodeddata',
            mimeType: 'image/png'
          }
        ],
        additionalFields: {
          timestamp: '2025-09-21T17:00:00Z',
          metadata: { version: '1.0' }
        }
      };

      const result = McpParser.parseResponse(JSON.stringify(complexResponse));
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as any).content).toHaveLength(3);
        expect((result.data as any).content[0].type).toBe('text');
        expect((result.data as any).content[1].type).toBe('resource');
        expect((result.data as any).content[2].type).toBe('image');
      }
    });
  });

  describe('parseToolResponse', () => {
    it('should parse valid tool response', () => {
      const toolResponse = JSON.stringify({
        content: [{ type: 'text', text: 'Tool output' }]
      });

      const result = McpParser.parseToolResponse(toolResponse);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toHaveLength(1);
      }
    });

    it('should reject non-tool responses', () => {
      const successResponse = JSON.stringify({
        success: true,
        data: 'not a tool response'
      });

      const result = McpParser.parseToolResponse(successResponse);
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Not a valid tool response');
    });
  });

  describe('parseSuccessResponse', () => {
    it('should parse valid success response', () => {
      const successResponse = JSON.stringify({
        success: true,
        data: { result: 'success' }
      });

      const result = McpParser.parseSuccessResponse(successResponse);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.data.result).toBe('success');
      }
    });

    it('should reject non-success responses', () => {
      const errorResponse = JSON.stringify({
        success: false,
        error: 'failed'
      });

      const result = McpParser.parseSuccessResponse(errorResponse);
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Not a valid success response');
    });
  });

  describe('parseErrorResponse', () => {
    it('should parse valid error response', () => {
      const errorResponse = JSON.stringify({
        success: false,
        error: 'Something failed'
      });

      const result = McpParser.parseErrorResponse(errorResponse);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(false);
        expect(result.data.error).toBe('Something failed');
      }
    });

    it('should reject non-error responses', () => {
      const successResponse = JSON.stringify({
        success: true,
        data: 'not an error'
      });

      const result = McpParser.parseErrorResponse(successResponse);
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Not a valid error response');
    });
  });

  describe('validateContent', () => {
    it('should validate correct content', () => {
      const content = [
        { type: 'text', text: 'Hello' },
        { type: 'resource', resource: { uri: 'file://test.txt' } }
      ];

      const result = McpParser.validateContent(content);
      expect(result.valid).toBe(true);
    });

    it('should reject text content without text field', () => {
      const content = [{ type: 'text' }];
      const result = McpParser.validateContent(content);
      expect(result.valid).toBe(false);
      expect((result as any).error).toContain('Text content item missing text field');
    });

    it('should reject image content without required fields', () => {
      const content = [{ type: 'image', data: 'base64' }]; // missing mimeType
      const result = McpParser.validateContent(content);
      expect(result.valid).toBe(false);
      expect((result as any).error).toContain('Image content item missing data or mimeType');
    });

    it('should reject resource content without uri', () => {
      const content = [{ type: 'resource', resource: { name: 'test' } }]; // missing uri
      const result = McpParser.validateContent(content);
      expect(result.valid).toBe(false);
      expect((result as any).error).toContain('Resource content item missing resource.uri');
    });
  });

  describe('extractTextContent', () => {
    it('should extract text content from tool response', () => {
      const response = {
        content: [
          { type: 'text', text: 'First text' },
          { type: 'resource', resource: { uri: 'file://test' } },
          { type: 'text', text: 'Second text' }
        ]
      };

      const texts = McpParser.extractTextContent(response as any);
      expect(texts).toEqual(['First text', 'Second text']);
    });

    it('should return empty array for non-tool response', () => {
      const response = {
        success: true,
        data: 'not a tool response'
      };

      const texts = McpParser.extractTextContent(response as any);
      expect(texts).toEqual([]);
    });
  });

  describe('extractAllContent', () => {
    it('should extract all content with type information', () => {
      const response = {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file://test.txt', name: 'test' } }
        ]
      };

      const allContent = McpParser.extractAllContent(response as any);
      expect(allContent).toHaveLength(3);
      expect(allContent[0]).toEqual({ type: 'text', content: 'Hello' });
      expect(allContent[1]).toEqual({
        type: 'image',
        content: { data: 'base64data', mimeType: 'image/png' }
      });
      expect(allContent[2]).toEqual({
        type: 'resource',
        content: { uri: 'file://test.txt', name: 'test' }
      });
    });
  });

  describe('edge cases and attack vectors', () => {
    it('should handle null input', () => {
      const result = McpParser.parseResponse(null as any);
      expect(result.success).toBe(false);
    });

    it('should handle undefined input', () => {
      const result = McpParser.parseResponse(undefined as any);
      expect(result.success).toBe(false);
    });

    it('should handle circular JSON references gracefully', () => {
      const obj: any = { content: [{ type: 'text', text: 'test' }] };
      obj.circular = obj;

      // JSON.stringify will throw on circular references
      expect(() => JSON.stringify(obj)).toThrow();

      // But if someone tries to parse a circular reference that was somehow stringified
      const result = McpParser.parseResponse('{"circular": "ref"}');
      expect(result.success).toBe(false);
    });

    it('should handle unicode and special characters', () => {
      const unicodeResponse = {
        content: [{
          type: 'text',
          text: '🎯 Unicode test with emojis 中文 العربية русский'
        }]
      };

      const result = McpParser.parseResponse(JSON.stringify(unicodeResponse));
      expect(result.success).toBe(true);
    });

    it('should handle very long strings', () => {
      const longString = 'x'.repeat(1000000); // 1MB string
      const response = {
        content: [{
          type: 'text',
          text: longString
        }]
      };

      const result = McpParser.parseResponse(JSON.stringify(response));
      expect(result.success).toBe(true);
    });

    it('should handle numbers, booleans, and special values', () => {
      const response = {
        content: [{
          type: 'text',
          text: 'test'
        }],
        additionalFields: {
          number: 42,
          boolean: true,
          nullValue: null,
          array: [1, 2, 3],
          float: 3.14159
        }
      };

      const result = McpParser.parseResponse(JSON.stringify(response));
      expect(result.success).toBe(true);
    });
  });
});

export default McpParser;