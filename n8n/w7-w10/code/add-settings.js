// The clinic's Settings rows (Key -> Value) next to its registry row.
const clinics = $('%S% – Split clinics').all();
return $input.all().map((item, i) => {
  const s = {};
  for (const r of item.json.records || []) {
    const f = r.fields || {};
    if (f.Key) s[String(f.Key).trim()] = f.Value;
  }
  return { json: { ...clinics[i].json, clinic_name: String(s.clinic_name || clinics[i].json.registry_clinic_name || ''), settings: s }, pairedItem: { item: i } };
});
