import httpx

r = httpx.get('http://172.16.36.75:5000/api/tags', timeout=10)
data = r.json()
models = data.get('models', [])
print(f"Total models: {len(models)}")
for m in models:
    name = m.get('name', 'unknown')
    details = m.get('details', {})
    size = details.get('parameter_size', '?')
    families = str(details.get('families', []))
    print(name + "   size=" + str(size) + "   families=" + families)
