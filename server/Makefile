all : tle2image

tle2image : tle2image.c
	gcc -o $@ $^ -O2 -lm -g -I. -lz

download :
	wget -O active_satellites.tle "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
	wget -O full_catalog.tle "https://celestrak.org/NORAD/elements/catalog.txt"

update : tle2image
	./tle2image active_satellites.tle /var/www/html/satviewer/lastsat.png
	./tle2image full_catalog.tle /var/www/html/satviewer/fullcatalog.png
	cp /var/www/html/satviewer/fullcatalog.png /var/www/html/satviewer/history/fullcatalog.`date +%Y%m%d-%H%M%S`.png


validate : validate.c
	gcc -o $@ $^ -O2 -lm -g -lz


#################################################
# Stars
#################################################

stars_texture_maker : star_texture_maker.c
	gcc -o $@ $^ -O2 -lm -g

constellationship.fab :
	wget https://raw.githubusercontent.com/Stellarium/stellarium/3989f74f5d1ec0ad233c9b2c635a1d4f13d3302b/skycultures/modern/constellationship.fab -O constellationship.fab

hip2.dat :
	wget http://cdsarc.u-strasbg.fr/ftp/I/311/hip2.dat.gz -O hip2.dat.gz
	gunzip hip2.dat.gz

initial : hip2.dat constellationship.fab star_texture_maker
	./star_texture_maker hip2.dat constellationship.fab /var/www/html/cnsky/hip2.png /var/www/html/cnsky/constallationship.png

clean :
	rm -rf tle2image hip2.dat constellationship.fab star_texture_maker
