# 2025 movie charts

Generated artifacts for the requested analysis. `movie_2025_data.csv` contains the 200 rows exposed by Box Office Mojo's 2025 domestic-gross table, joined to cached Wikipedia infobox budget values and bulk Wikidata budget values where found, plus live Letterboxd reported average rating and rating-count values where a matching Letterboxd film page could be resolved.

The four charted attributes are domestic gross, production budget, Letterboxd rating count, and Letterboxd reported average rating. `output/` contains one chart for each pair of attributes. Each chart has a single least-squares polynomial curve with up to 6 terms, reports the fitted equation in the transformed plotting space, and includes R^2. There is no median-splitting curve.

Point labels are selected from extrema and largest curve residuals rather than labeling every point. Older rerelease/event rows without a distinct current Letterboxd film page are left blank rather than borrowing unrelated historical page data.
