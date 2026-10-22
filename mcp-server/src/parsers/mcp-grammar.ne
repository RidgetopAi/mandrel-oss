# AIDIS MCP Response Grammar
# Nearley grammar for robust MCP response parsing
# Eliminates brittle JSON parsing with structured grammar

@builtin "json.ne"

# Main MCP response structure
mcpResponse ->
    successResponse {% id %}
  | errorResponse {% id %}
  | toolResponse {% id %}

# Success response structure
successResponse ->
    "{" _ "\"success\":" _ "true" _ "," _ "\"data\":" _ value _ ("," _ additionalFields):? _ "}" {%
      function(d) {
        return {
          type: 'success',
          success: true,
          data: d[8],
          additionalFields: d[10] ? d[10][2] : {}
        };
      }
    %}

# Error response structure
errorResponse ->
    "{" _ "\"success\":" _ "false" _ "," _ "\"error\":" _ string _ ("," _ additionalFields):? _ "}" {%
      function(d) {
        return {
          type: 'error',
          success: false,
          error: d[8],
          additionalFields: d[10] ? d[10][2] : {}
        };
      }
    %}

# Tool response structure (MCP content format)
toolResponse ->
    "{" _ "\"content\":" _ contentArray _ ("," _ additionalFields):? _ "}" {%
      function(d) {
        return {
          type: 'tool',
          content: d[4],
          additionalFields: d[6] ? d[6][2] : {}
        };
      }
    %}

# Content array for tool responses
contentArray ->
    "[" _ (contentItem (_ "," _ contentItem):*):? _ "]" {%
      function(d) {
        if (!d[2]) return [];
        return [d[2][0]].concat(d[2][1].map(function(item) { return item[3]; }));
      }
    %}

# Individual content items
contentItem ->
    textContent {% id %}
  | resourceContent {% id %}
  | imageContent {% id %}

# Text content type
textContent ->
    "{" _ "\"type\":" _ "\"text\"" _ "," _ "\"text\":" _ string _ "}" {%
      function(d) {
        return {
          type: 'text',
          text: d[10]
        };
      }
    %}

# Resource content type
resourceContent ->
    "{" _ "\"type\":" _ "\"resource\"" _ "," _ "\"resource\":" _ resourceObject _ "}" {%
      function(d) {
        return {
          type: 'resource',
          resource: d[10]
        };
      }
    %}

# Image content type
imageContent ->
    "{" _ "\"type\":" _ "\"image\"" _ "," _ "\"data\":" _ string _ "," _ "\"mimeType\":" _ string _ "}" {%
      function(d) {
        return {
          type: 'image',
          data: d[10],
          mimeType: d[14]
        };
      }
    %}

# Resource object structure
resourceObject ->
    "{" _ "\"uri\":" _ string _ ("," _ "\"name\":" _ string):? _ ("," _ "\"description\":" _ string):? _ "}" {%
      function(d) {
        return {
          uri: d[4],
          name: d[6] ? d[6][4] : undefined,
          description: d[8] ? d[8][4] : undefined
        };
      }
    %}

# Additional fields for extensibility
additionalFields ->
    keyValuePairs

keyValuePairs ->
    keyValuePair (_ "," _ keyValuePair):* {%
      function(d) {
        const result = {};
        result[d[0].key] = d[0].value;
        if (d[1]) {
          d[1].forEach(function(pair) {
            result[pair[3].key] = pair[3].value;
          });
        }
        return result;
      }
    %}

keyValuePair ->
    string _ ":" _ value {%
      function(d) {
        return { key: d[0], value: d[4] };
      }
    %}

# Import standard JSON value parsing
value -> json {% id %}
string -> json {% function(d) { return typeof d[0] === 'string' ? d[0] : JSON.stringify(d[0]); } %}
number -> json {% function(d) { return typeof d[0] === 'number' ? d[0] : parseFloat(d[0]); } %}

# Whitespace
_ -> [\s]:*