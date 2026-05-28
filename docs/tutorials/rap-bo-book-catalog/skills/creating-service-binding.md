---
name: creating-service-binding
description: 'Service binding rules — wraps a service definition with a binding variant and a publication flag. Pass `binding_variant` EXPLICITLY (since core@5.2.0 + adt-clients@5.0.0 the default is ODATA_V4_UI; older clients silently created Web API — explicit is safer). Variants — `ODATA_V4_UI` for Fiori Elements (default), `ODATA_V4_WEB_API` for programmatic V4 client, `ODATA_V2_UI` for legacy Fiori, `ODATA_V2_WEB_API` for legacy V2 programmatic. The underlying service definition must be ACTIVE before binding creation. Activate the binding after creation, then PUBLISH SEPARATELY via PublishServiceBinding — activation does not auto-publish, and an active-but-unpublished binding is unreachable.'
---
