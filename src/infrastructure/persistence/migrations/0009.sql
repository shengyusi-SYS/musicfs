CREATE INDEX source_plugin_cache_expiry ON source_plugin_cache(instance_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX source_plugin_cache_scope ON source_plugin_cache(instance_id, epoch, plugin_generation, plugin_revision);
