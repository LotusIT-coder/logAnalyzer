                            Table "public.event"
   Column    |           Type           | Collation | Nullable |   Default   
-------------+--------------------------+-----------+----------+-------------
 id          | uuid                     |           | not null | 
 source_id   | uuid                     |           | not null | 
 timestamp   | timestamp with time zone |           | not null | 
 severity    | text                     |           | not null | 
 service     | text                     |           |          | 
 host        | text                     |           |          | 
 environment | text                     |           |          | 
 message     | text                     |           | not null | 
 event_type  | text                     |           |          | 
 fields_json | jsonb                    |           | not null | '{}'::jsonb
 fingerprint | text                     |           |          | 
 created_at  | timestamp with time zone |           |          | now()
Indexes:
    "event_pkey" PRIMARY KEY, btree (id)
    "idx_event_created_at" btree (created_at DESC)
    "idx_event_fields_gin" gin (fields_json)
    "idx_event_fingerprint" btree (fingerprint)
    "idx_event_host" btree (host)
    "idx_event_service" btree (service)
    "idx_event_severity" btree (severity)
    "idx_event_severity_timestamp" btree (severity, "timestamp" DESC)
    "idx_event_source_id_timestamp" btree (source_id, "timestamp" DESC)
    "idx_event_timestamp" btree ("timestamp" DESC)
Foreign-key constraints:
    "event_source_id_fkey" FOREIGN KEY (source_id) REFERENCES source(id) ON DELETE CASCADE
Referenced by:
    TABLE "event_index_outbox" CONSTRAINT "event_index_outbox_event_id_fkey" FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE
    TABLE "incident_event" CONSTRAINT "incident_event_event_id_fkey" FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE

