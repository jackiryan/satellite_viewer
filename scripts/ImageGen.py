from astropy.io import fits
import pandas as pd
import numpy as np
from PIL import Image
from numpy import linalg as LA

# bunch of junk to deal with format of my table
test = pd.read_table('Assets/SkyBox/7thmag.txt', header = 4, sep = '|')
test = test.drop(np.where(test['Mag B '] =='     ~' )[0])
test = test.drop(0)
test = test.drop(len(test))
test = test.drop([4434,2646,14962])
test = test.dropna()

test = test.sort_values('Mag V ')

starCoord = test['     coord2 (ICRS,J2000/2000)      ']
starCoord = starCoord.str.split(" ", expand = True)
ra = starCoord[0].to_numpy(dtype='float16')
dec = starCoord[1].to_numpy(dtype='float16')

mag = test['Mag V '].to_numpy(dtype='float16')
magB = test['Mag B '].to_numpy(dtype='float16')

color = magB-mag

ra = np.delete(ra,np.where(color>1.4))
dec = np.delete(dec,np.where(color>1.4))
mag = np.delete(mag,np.where(color>1.4))
color = np.delete(color,np.where(color>1.4))


# Conversion from color to temperature. Could be improved upon in future using other data
temp = 4600*((1/((0.92-color)+1.7))+(1/((0.92-color)+0.62)))


# Spherical to cartesian
Pz = np.sin(np.deg2rad(dec))
Py = np.cos(np.deg2rad(dec))*np.sin(np.deg2rad(ra))
Px = np.cos(np.deg2rad(dec))*np.cos(np.deg2rad(ra))
p = np.array([Px,Py,Pz]).T


# Equation 1 from paper
Pprime = (p.T/(abs(p)[:,0]+abs(p)[:,1]+abs(p)[:,2])).T


#  planer projection uses equation 2 in paper (NOTE: I think they made typo there because later in section 4.2
#  they show code for that equation that's slightly different. The code in section 4.2 seems to work corectly)
coord = []
for P in Pprime:
    if P[2] >= 0:
        coord.append(np.array([P[0],P[1]]))
    else:
        coord.append(np.array([np.sign(P[0])*(1-abs(P[1])), np.sign(P[1])*(1-abs(P[0]))]))

Starcoord = np.array(coord)


# create blank image
res = 1024
im = np.zeros([res,res,4])

# Convert projected coords to pixel space
Starcoord[:,0] = ((Starcoord[:,0]+1)/2)*res
Starcoord[:,1] = ((Starcoord[:,1]+1)/2)*res




def mag2_8bit(magnitude):
    """

    :param magnitude:
    :return: linear scale of magnitude to full magnitude range of dataset
    """
    maxMag = -1.46
    minMag = 7

    return np.rint(((((magnitude - maxMag) - (minMag-maxMag)) * -1) / (minMag-maxMag)) * 255)

def temp2_8bit(temperature):
    """

    :param temperature:
    :return: temperature in log space scaled to the range given. so 2650 is 0 and 37000 is 255
    """
    minTemp = 2650
    maxTemp = 37000

    newT = (np.log10(temperature/minTemp)/ np.log10(maxTemp/minTemp))

    return np.rint(newT*255)

def coord2_8bit(offset):

    return np.rint(((offset+1.5)/3)*255)



# loop over stars to assign to pixel in image
skipCount =0
altCheck = 0
for i, star in enumerate(Starcoord):

    x_loc = star[0].__ceil__()-1
    y_loc = star[1].__ceil__()-1

    # if no other data is written to pixel, write this star to current pixel
    if ((im[x_loc,y_loc,0] == 0) & (im[x_loc,y_loc,1] == 0)& (im[x_loc,y_loc,2] == 0)& (im[x_loc,y_loc,3] == 0)):
        x_off = (x_loc-0.5)-(star[0]-1)
        y_off = (y_loc-0.5)-(star[1]-1)

        im[x_loc,y_loc,0] = coord2_8bit(x_off)
        im[x_loc, y_loc, 1] = coord2_8bit(y_off)
        im[x_loc, y_loc, 2] = mag2_8bit(mag[i])
        im[x_loc, y_loc, 3] = temp2_8bit(temp[i])


    # is data already exists for pixel, search for the nearest other pixel
    else:
        alt_coords = np.array([[x_loc-1,y_loc],[x_loc+1,y_loc],[x_loc,y_loc-1],[x_loc,y_loc+1],
                               [x_loc-1,y_loc-1],[x_loc+1,y_loc-1],[x_loc-1,y_loc+1],[x_loc+1,y_loc+1]])


        # modify alt coords to account for texture wrap
        alt_coords[np.where(alt_coords >= res)] = alt_coords[np.where(alt_coords >= res)] - res
        alt_coords[np.where(alt_coords <= -1)] = alt_coords[np.where(alt_coords <= -1)] + res

        # sort neighbors by closest
        distance = LA.norm(np.array([star[0],star[1]])-(alt_coords-0.5), axis=1)
        indices = distance.argsort()

        # Check nearest neighbors first if they have data written to them
        altCheck += 1
        for dist in indices:

            # if neighbor is empty, write data to it including offset from new pixel to real star location
            if ((im[alt_coords[dist][0],alt_coords[dist][1],0] == 0)&(im[alt_coords[dist][0],alt_coords[dist][1],1] == 0)
                    &(im[alt_coords[dist][0],alt_coords[dist][1],2] == 0)&(im[alt_coords[dist][0],alt_coords[dist][1],3] == 0)):
                x_off = (alt_coords[dist][0] - 0.5)-(star[0]-1)
                y_off = (alt_coords[dist][1] - 0.5) -(star[1]-1)

                im[alt_coords[dist][0], alt_coords[dist][1], 0] = coord2_8bit(x_off)
                im[alt_coords[dist][0], alt_coords[dist][1], 1] = coord2_8bit(y_off)
                im[alt_coords[dist][0], alt_coords[dist][1], 2] = mag2_8bit(mag[i])
                im[alt_coords[dist][0], alt_coords[dist][1], 3] = temp2_8bit(temp[i])


                break

            else:
                skipCount += 0

        if skipCount== 8:
            print("skipped")


image = Image.fromarray(im.astype('uint8'))
image.save('Assets/SkyBox/testStarMap1024.png')
image.show()