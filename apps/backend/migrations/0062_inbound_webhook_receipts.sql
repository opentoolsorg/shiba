CREATE TABLE inbound_webhook_receipts (
  route_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  PRIMARY KEY (route_id, delivery_id)
);
CREATE INDEX inbound_webhook_receipts_age ON inbound_webhook_receipts(received_at);
