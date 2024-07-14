#include <stdio.h>

//#define USE_EXR

#ifdef USE_EXR
#define TINYEXR_IMPLEMENTATION
#define TINYEXR_USE_MINIZ 0
#include <zlib.h>
#include "tinyexr.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
#endif

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"


int main( int argc, char ** argv )
{
	if( argc != 2 )
	{
		fprintf( stderr, "Error: Usage: [tool] [image]\n" );
		return -8;
	}

#ifdef USE_EXR
	float* data = 0; // width * height * RGBA
	int width;
	int height;
	const char* err = NULL; // or nullptr in C++11
	int ret = LoadEXR(&data, &width, &height, argv[1], &err);
	if (ret != TINYEXR_SUCCESS) {
		if (err) {
			fprintf(stderr, "ERR : %s\n", err);
			return -9;
		}
	}
#else
	float* data = 0; // width * height * RGBA
	int width, height, n;
	data = (float*)stbi_load( argv[1], &width, &height, &n, 0 );
	int ret = n;
#endif

	if( !data )
	{
		fprintf( stderr, "Error: can't open %s\n", argv[1] );
	}
	printf( "%d %d %d\n", width, height, ret );
	printf( "%f %f %f\n", data[0], data[1], data[2] );
	printf( "%f %f %f\n", data[3], data[4], data[5] );
	printf( "%f %f %08x\n", data[6], data[7], ((uint32_t*)data)[5] );

	printf( "next\n" );
	printf( "%f %f (%08x) %f\n", data[24], data[25], ((uint32_t*)data)[25], data[26] );

	printf( "next\n" );
	printf( "%08x %08x %08x\n", ((uint32_t*)data)[256], ((uint32_t*)data)[257], ((uint32_t*)data)[258] );

	free(data); // release memory of image data
}

