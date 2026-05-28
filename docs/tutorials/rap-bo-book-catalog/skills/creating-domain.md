---
name: creating-domain
description: 'Domain creation rules. One concrete ABAP type with explicit size: CHAR 40, NUMC 4, DEC 10,2, UNIT, etc. Never leave length open (STRING without length, CHAR without length, DEC without precision) — the create call must carry exact size. Name follows the project prefix Z##_D_<NAME>; the pair Z##_D_<NAME> / Z##_E_<NAME> (domain / data element) shares the same <NAME> suffix. Domains often stay inactive after CreateDomain — activate explicitly with the prefix filter ("Activate all inactive objects starting with Z##_D_"), never a bare "Activate all inactive objects". Verify with ReadDomain per name and confirm active: true in the response; "all domains active" without that read-back is not evidence.'
---
