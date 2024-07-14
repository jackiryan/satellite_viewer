#include <stdio.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdint.h>
#include <linux/limits.h>

#include "/csgp4/csgp4.h"
#include "/csgp4/os_generic.h"

//#define TLEEXR

#ifdef TLEEXR
#define TINYEXR_IMPLEMENTATION
#define TINYEXR_USE_MINIZ 0
//#define TINYEXR_USE_STB_ZLIB 1

#include <zlib.h>
#include "tinyexr.h"
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#endif

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

// Assume 24 floats per entry.
#define FPERE 24
#ifdef TLEEXR
#define DATAW 512
#else
#define DATAW 2048
#endif
#define DATAH 512
#define USABLE_W (((DATAW)/(FPERE))*(FPERE))

float data[2048*2048];

int main( int argc, char ** argv )
{
	if( argc != 3 )
	{
		fprintf( stderr, "Error: Usage: ./tle2image [infile] [outfile]\n" );
		return -10;
	}

	FILE * f = fopen( argv[1], "r" );
	if( !f )
	{
		fprintf( stderr, "Error: failed to open input file %s\n", argv[1] );
		return -11;
	}
	int numObjects = 0;
	struct TLEObject * objects = 0;
	int r = ParseFileOrString( f, 0, &objects, &numObjects );
	if( r )
	{
		fprintf( stderr, "Error: input file %s has errors\n", argv[1] );
		return -12;
	}
	printf( "Read in %d objects\n", numObjects );

	int outObjNumber = 0;

	int i;
	for( i = 0; i < numObjects; i++ )
	{
		struct TLEObject * o = objects + i;
		int validflags = o->valid;
		if( ( o->valid & 7 ) == 7 ) continue;

		o->valid = 0;
		// Scan through list and make sure we are the best object.
		int j;
		for( j = i+1; j < numObjects; j++ )
		{
			struct TLEObject * c = objects + j;
			if( ( ( c->valid & 7 ) == 7 ) && strcmp( o->objectName, c->objectName ) == 0 & strcmp( o->internationalDesignator, c->internationalDesignator ) == 0 )
			{
				// we have a duplicate, find one with most recent data.
				if( c->jdsatepoch >= o->jdsatepoch && c->jdsatepochF > o->jdsatepochF )
				{
					validflags = c->valid;
					o = c;
				}
				c->valid = 0;
			}
		}


		int oox = (outObjNumber * FPERE) % USABLE_W;
		int ooy = 1+((outObjNumber * FPERE) / USABLE_W);

		float * px =  (float*)&data[oox+ooy*DATAW];
		px[0] = validflags; // valid flags - might be different?
		px[1] = o->jdsatepoch;
		px[2] = o->jdsatepochF;
		px[3] = o->meanMotion1;
		px[4] = o->dragTerm;
		px[5] = o->inclination;
		px[6] = o->rightAscensionOfTheAscendingNode;
		px[7] = o->eccentricity;
		px[8] = o->argumentOfPerigee;
		px[9] = o->meanAnomaly;
		px[10] = o->meanMotion;
		px[11] = o->revolutionNumberAtEpoch; // Possibly reserved.
		px[12] = o->elementSetNumber; // Possibly reserved.
		px[13] = o->catalogNumber;    // Possibly reserved.
		memcpy( px+14, o->internationalDesignator, 12 );
		memcpy( px+17, o->objectName, 24 );
		//px[17] = 12345.67;
		//puts( o->objectName );
		//printf( "%08x\n", *(uint32_t*)(px+19));


		outObjNumber++;
	}
	printf( "Parsed %d objects\n", outObjNumber );


	{
		// Info Block
		int oox = (0 * FPERE) % USABLE_W;
		int ooy = (0 * FPERE) / USABLE_W;
		float * px =  (float*)&data[oox+ooy*DATAW];
		px[0] = 7;
		double dNow = OGGetAbsoluteTime() / 86400.0;
		px[1] = ((int)dNow) + SGP4_FROM_EPOCH_DAYS;
		px[2] = dNow - (int)dNow;
		px[3] = numObjects;
		px[4] = outObjNumber;

		// Junk!!!
		uint32_t n = 0xff83211f;
		px[5] = *(float*)&n;
		px[6] = *(float*)"HELO";
		px[12] = *(float*)"HEL1";
		px[14] = *(float*)"HEL2";
		outObjNumber++;

		// Build color ramp.
		int j;
		for( j = 0; j < 256; j++ )
		{
			uint32_t word = j | (j<<8) | (j<<16) | (j<<24);
			px[256+j] = *((float*)&word);
		}
	}



	// Assume 32 floats per object.
	char tempfile[PATH_MAX+1];
	snprintf( tempfile, sizeof(tempfile)-1, "%s.temp", argv[2] );

#ifdef TLEEXR

/*
	EXRHeader header;
	InitEXRHeader(&header);
	EXRImage image;
	InitEXRImage(&image);
	image.num_channels = 4;

	std::vector<float> images[4];
	images[0].resize(DATAW * DATAH);
	images[1].resize(DATAW * DATAH);
	images[2].resize(DATAW * DATAH);
	images[3].resize(DATAW * DATAH);



	// Split RGBRGBRGB... into R, G and B layer
	for (int i = 0; i < DATAW * DATAH; i++) {
		images[0][i] = data[4*i+0];
		images[1][i] = data[4*i+1];
		images[2][i] = data[4*i+2];
		images[3][i] = data[4*i+3];
	}

	float* image_ptr[4];
	image_ptr[0] = &(images[3].at(0)); // A
	image_ptr[1] = &(images[2].at(0)); // B
	image_ptr[2] = &(images[1].at(0)); // G
	image_ptr[3] = &(images[0].at(0)); // R

	image.images = (unsigned char**)image_ptr;
	image.width = DATAW;
	image.height = DATAH;

	header.num_channels = 4;
	header.compression_type = TINYEXR_COMPRESSIONTYPE_ZIP;
	header.channels = (EXRChannelInfo *)malloc(sizeof(EXRChannelInfo) * header.num_channels);
	// Must be (A)BGR order, since most of EXR viewers expect this channel order.
	strncpy(header.channels[0].name, "A", 255); header.channels[0].name[strlen("A")] = '\0';
	strncpy(header.channels[1].name, "B", 255); header.channels[1].name[strlen("B")] = '\0';
	strncpy(header.channels[2].name, "G", 255); header.channels[2].name[strlen("G")] = '\0';
	strncpy(header.channels[3].name, "R", 255); header.channels[3].name[strlen("R")] = '\0';

	header.pixel_types = (int *)malloc(sizeof(int) * header.num_channels);
	header.requested_pixel_types = (int *)malloc(sizeof(int) * header.num_channels);
	for (int i = 0; i < header.num_channels; i++) {
		header.pixel_types[i] = TINYEXR_PIXELTYPE_FLOAT; // pixel type of input image
		header.requested_pixel_types[i] = TINYEXR_PIXELTYPE_FLOAT; // pixel type of output image to be stored in .EXR
	}



	const char* err = NULL; // or nullptr in C++11 or later.
	r = SaveEXRImageToFile(&image, &header, tempfile, &err);
	if( r )
	{
		fprintf( stderr, "%s\n", err );
		return -9;
	}
*/

	const char* err = NULL; // or nullptr in C++11 or later.
	r = SaveEXR(data, DATAW, DATAH,
                   3, 0,
                   tempfile, &err);
	if( r )
	{
		fprintf( stderr, "%s\n", err );
		return -9;
	}

#else
	r = stbi_write_png( tempfile, DATAW, DATAH, 4, (uint8_t*)data, DATAW*4 );
	printf( "Write status: %d\n", r );
	if( r == 0 )
	{
		fprintf( stderr, "Error: failed to write out PNG\n" );
		return -9;
	}
#endif
	printf( "Building image complete.\n" );
	// Need to copy file into place to make sure downloads don't get corrutped.
	r = rename( tempfile, argv[2] );
	if( r == 0 )
	{
		printf( "Copy into place ok\n" );
	}
	else
	{
		fprintf( stderr, "Error copying into place\n" );
	}
	return 0;
}

