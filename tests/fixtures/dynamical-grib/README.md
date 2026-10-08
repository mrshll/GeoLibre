# GRIB2 fixtures

Ported unchanged from dynamical.org's explorer fixtures. `make_fixtures.py`
subsamples real 0.25° GRIB2 messages to a 4° global grid (46 × 90), then
re-encodes them with ecCodes. `expected.json` records source URLs, byte ranges,
fixture hashes, and bit-exact float64 expectations from gribberish 1.8.0's
Python zarr codec.

| Fixture | Original message | Packing |
| --- | --- | --- |
| `simple.grib2` | NOAA GFS temperature at 2 m, 2026-09-25 12 UTC +6 h | DRS 5.0 |
| `complex-spatial.grib2` | Same NOAA GFS temperature message | DRS 5.3 |
| `simple-bitmap.grib2` | NOAA GFS liquid volumetric soil moisture at 10–40 cm, same run | DRS 5.0 + bitmap |
| `complex-spatial-bitmap.grib2` | Same NOAA GFS soil moisture message | DRS 5.3 + bitmap |
| `ccsds-south-first.grib2` | ECMWF AIFS single temperature at 2 m, 2026-09-25 12 UTC +36 h | DRS 5.42, reordered south-first |

The NOAA GFS source data are public domain. The AIFS-derived fixture is ECMWF
open data under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/):
**Copyright European Centre for Medium-Range Weather Forecasts (ECMWF)**.
It was subsampled, reordered and re-encoded as described above; ECMWF has not
endorsed these changes. The source was served from the `ecmwf-open-data`
Google Cloud bucket; its exact URL and byte range remain in `expected.json`.

Fixtures cover DRS **5.0, 5.3 and 5.42**, with raw and adjusted orientation
cases for the temperature fixtures. They do not cover 5.2, 5.41 or 5.40.

To regenerate:

```bash
uv run tests/fixtures/dynamical-grib/make_fixtures.py
```

ECMWF keeps only recent runs; update `AIFS_T2M` to a newer source message when
the original expires. Regeneration changes the expected hashes and values.
