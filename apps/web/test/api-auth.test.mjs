import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authFields } from '../src/components/ui/api-layout/auth.ts';

test('authorization descriptions include escaped examples and scopes', () => {
  const fields = authFields([[{
    scheme: 'api', type: 'http', bearerFormat: 'token', headerName: 'Authorization', scopes: ['read:<script>'],
  }]]);
  assert.equal(fields[0].descriptionHtml, '<code>Authorization: Bearer &lt;token&gt;</code> · Scopes: <code>read:&lt;script&gt;</code>');
  assert.equal(fields[0].required, true);
});
