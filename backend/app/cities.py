"""City catalogue — mirrors src/data/cities.ts (keep the two in sync)."""

from dataclasses import dataclass


@dataclass(frozen=True)
class City:
    id: str
    name: str
    country: str
    lat: float
    lon: float
    timezone: str


CITIES: dict[str, City] = {
    c.id: c
    for c in [
        City("istanbul", "Istanbul", "Türkiye", 41.0369, 28.985, "Europe/Istanbul"),
        City("ankara", "Ankara", "Türkiye", 39.9208, 32.8541, "Europe/Istanbul"),
        City("izmir", "İzmir", "Türkiye", 38.4237, 27.1428, "Europe/Istanbul"),
        City("tekirdag", "Tekirdağ", "Türkiye", 40.9781, 27.5117, "Europe/Istanbul"),
        City("edirne", "Edirne", "Türkiye", 41.6764, 26.5557, "Europe/Istanbul"),
        City("bursa", "Bursa", "Türkiye", 40.1828, 29.067, "Europe/Istanbul"),
        City("kocaeli", "Kocaeli", "Türkiye", 40.7656, 29.9406, "Europe/Istanbul"),
        City("antalya", "Antalya", "Türkiye", 36.8848, 30.704, "Europe/Istanbul"),
        City("berlin", "Berlin", "Germany", 52.5163, 13.3777, "Europe/Berlin"),
        City("london", "London", "United Kingdom", 51.5098, -0.118, "Europe/London"),
        City("newyork", "New York", "United States", 40.7549, -73.984, "America/New_York"),
    ]
}
