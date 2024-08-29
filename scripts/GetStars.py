
from astroquery.simbad import Simbad

# Define the query criteria
custom_simbad = Simbad()
custom_simbad.TIMEOUT = 360  # Set timeout to 180 seconds (adjust as needed)

custom_simbad.add_votable_fields('flux(V)')  # Add visual magnitude to the results

# Perform the query for stars with visual magnitude less than 7
result_table = custom_simbad.query_criteria('Vmag < 3', otype='Star')

# Print or process the results
print(result_table)
