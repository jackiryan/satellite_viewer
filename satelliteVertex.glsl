
struct elsetrec
{
    int       satnum;
    int       epochyr, epochtynumrev;
    int       error;
    int      operationmode;
    int      init, method;

    /* Near Earth */
    int   isimp;
    float aycof  , con41  , cc1    , cc4      , cc5    , d2      , d3   , d4    ,
          delmo  , eta    , argpdot, omgcof   , sinmao , t       , t2cof, t3cof ,
          t4cof  , t5cof  , x1mth2 , x7thm1   , mdot   , nodedot, xlcof , xmcof ,
          nodecf;

    /* Deep Space */
    int   irez;
    float d2201  , d2211  , d3210  , d3222    , d4410  , d4422   , d5220 , d5232 ,
          d5421  , d5433  , dedt   , del1     , del2   , del3    , didt  , dmdt  ,
          dnodt  , domdt  , e3     , ee2      , peo    , pgho    , pho   , pinco ,
          plo    , se2    , se3    , sgh2     , sgh3   , sgh4    , sh2   , sh3   ,
          si2    , si3    , sl2    , sl3      , sl4    , gsto    , xfact , xgh2  ,
          xgh3   , xgh4   , xh2    , xh3      , xi2    , xi3     , xl2   , xl3   ,
          xl4    , xlamo  , zmol   , zmos     , atime  , xli     , xni;

    float   a, altp, alta, epochdays, jdsatepoch, jdsatepochF, nddot, ndot,
            bstar, rcse, inclo, nodeo, ecco, argpo, mo, no_kozai;
    // sgp4fix add new variables from tle
    int  classification, intldesg[11];
    int   ephtype;
    int   elnum    , revnum;
    // sgp4fix add unkozai'd variable
    float no_unkozai;
    // sgp4fix add singly averaged variables
    float am     , em     , im     , Om       , om     , mm      , nm;
    // sgp4fix add constant parameters to eliminate mutliple calls during execution
    float tumin, mu, radiusearthkm, xke, j2, j3, j4, j3oj2;

    //       Additional elements to capture relevant TLE and object information:       
    int dia_mm; // RSO dia in mm
    float period_sec; // Period in seconds
    int active; // "Active S/C" flag (0=n, 1=y) 
    int not_orbital; // "Orbiting S/C" flag (0=n, 1=y)  
    float rcs_m2; // "RCS (m^2)" storage  
};


static void dspace
    (
    int irez,
    float d2201, float d2211, float d3210, float d3222, float d4410,
    float d4422, float d5220, float d5232, float d5421, float d5433,
    float dedt, float del1, float del2, float del3, float didt,
    float dmdt, float dnodt, float domdt, float argpo, float argpdot,
    float t, float tc, float gsto, float xfact, float xlamo,
    float no,
    inout float atime, inout float em, inout float argpm, inout float inclm, inout float xli,
    inout float mm, inout float xni, inout float nodem, inout float dndt, inout float nm
    )
{
    const float pi = 3.14159265358979;
    const float twopi = 2.0 * pi;
    int iretn, iret;
    float delt, ft, theta, x2li, x2omi, xl, xldot, xnddt, xndt, xomi, g22, g32,
        g44, g52, g54, fasx2, fasx4, fasx6, rptim, step2, stepn, stepp;

    fasx2 = 0.13130908;
    fasx4 = 2.8843198;
    fasx6 = 0.37448087;
    g22 = 5.7686396;
    g32 = 0.95240898;
    g44 = 1.8014998;
    g52 = 1.0508330;
    g54 = 4.4108898;
    rptim = 4.37526908801129966e-3; // this equates to 7.29211514668855e-5 rad/sec
    stepp = 720.0;
    stepn = -720.0;
    step2 = 259200.0;

    /* ----------- calculate deep space resonance effects ----------- */
    dndt = 0.0;
    theta = mod(gsto + tc * rptim, twopi);
    em = em + dedt * t;

    inclm = inclm + didt * t;
    argpm = argpm + domdt * t;
    nodem = nodem + dnodt * t;
    mm = mm + dmdt * t;

    //   sgp4fix for negative inclinations
    //   the following if statement should be commented out
    //  if (inclm < 0.0)
    // {
    //    inclm = -inclm;
    //    argpm = argpm - pi;
    //    nodem = nodem + pi;
    //  }

    /* - update resonances : numerical (euler-maclaurin) integration - */
    /* ------------------------- epoch restart ----------------------  */
    //   sgp4fix for propagator problems
    //   the following integration works for negative time steps and periods
    //   the specific changes are unknown because the original code was so convoluted

    // sgp4fix take out atime = 0.0 and fix for faster operation
    ft = 0.0;
    if (irez != 0)
    {
        // sgp4fix streamline check
        if ((atime == 0.0) || (t * atime <= 0.0) || (abs(t) < abs(atime)))
        {
            atime = 0.0;
            xni = no;
            xli = xlamo;
        }
        // sgp4fix move check outside loop
        if (t > 0.0)
            delt = stepp;
        else
            delt = stepn;

        iretn = 381; // added for do loop
        iret = 0; // added for loop
        while (iretn == 381)
        {
            /* ------------------- dot terms calculated ------------- */
            /* ----------- near - synchronous resonance terms ------- */
            if (irez != 2)
            {
                xndt = del1 * sin(xli - fasx2) + del2 * sin(2.0 * (xli - fasx4)) +
                    del3 * sin(3.0 * (xli - fasx6));
                xldot = xni + xfact;
                xnddt = del1 * cos(xli - fasx2) +
                    2.0 * del2 * cos(2.0 * (xli - fasx4)) +
                    3.0 * del3 * cos(3.0 * (xli - fasx6));
                xnddt = xnddt * xldot;
            }
            else
            {
                /* --------- near - half-day resonance terms -------- */
                xomi = argpo + argpdot * atime;
                x2omi = xomi + xomi;
                x2li = xli + xli;
                xndt = d2201 * sin(x2omi + xli - g22) + d2211 * sin(xli - g22) +
                    d3210 * sin(xomi + xli - g32) + d3222 * sin(-xomi + xli - g32) +
                    d4410 * sin(x2omi + x2li - g44) + d4422 * sin(x2li - g44) +
                    d5220 * sin(xomi + xli - g52) + d5232 * sin(-xomi + xli - g52) +
                    d5421 * sin(xomi + x2li - g54) + d5433 * sin(-xomi + x2li - g54);
                xldot = xni + xfact;
                xnddt = d2201 * cos(x2omi + xli - g22) + d2211 * cos(xli - g22) +
                    d3210 * cos(xomi + xli - g32) + d3222 * cos(-xomi + xli - g32) +
                    d5220 * cos(xomi + xli - g52) + d5232 * cos(-xomi + xli - g52) +
                    2.0 * (d4410 * cos(x2omi + x2li - g44) +
                    d4422 * cos(x2li - g44) + d5421 * cos(xomi + x2li - g54) +
                    d5433 * cos(-xomi + x2li - g54));
                xnddt = xnddt * xldot;
            }

            /* ----------------------- integrator ------------------- */
            // sgp4fix move end checks to end of routine
            if (abs(t - atime) >= stepp)
            {
                iret = 0;
                iretn = 381;
            }
            else // exit here
            {
                ft = t - atime;
                iretn = 0;
            }

            if (iretn == 381)
            {
                xli = xli + xldot * delt + xndt * step2;
                xni = xni + xndt * delt + xnddt * step2;
                atime = atime + delt;
            }
        }  // while iretn = 381

        nm = xni + xndt * ft + xnddt * ft * ft * 0.5;
        xl = xli + xldot * ft + xndt * ft * ft * 0.5;
        if (irez != 1)
        {
            mm = xl - 2.0 * nodem + 2.0 * theta;
            dndt = nm - no;
        }
        else
        {
            mm = xl - nodem - argpm + theta;
            dndt = nm - no;
        }
        nm = no + dndt;
    }

    //#include "debug4.cpp"
}  // dsspace

static void dpper
    (
    float e3, float ee2, float peo, float pgho, float pho,
    float pinco, float plo, float se2, float se3, float sgh2,
    float sgh3, float sgh4, float sh2, float sh3, float si2,
    float si3, float sl2, float sl3, float sl4, float t,
    float xgh2, float xgh3, float xgh4, float xh2, float xh3,
    float xi2, float xi3, float xl2, float xl3, float xl4,
    float zmol, float zmos, float inclo,
    int init,
    inout float ep, inout float inclp, inout float nodep, inout float argpp, inout float mp,
    int opsmode
    )
{
    /* --------------------- local variables ------------------------ */
    const float twopi = 2.0 * pi;
    float alfdp, betdp, cosip, cosop, dalf, dbet, dls,
        f2, f3, pe, pgh, ph, pinc, pl,
        sel, ses, sghl, sghs, shll, shs, sil,
        sinip, sinop, sinzf, sis, sll, sls, xls,
        xnoh, zf, zm, zel, zes, znl, zns;

    /* ---------------------- constants ----------------------------- */
    zns = 1.19459e-5;
    zes = 0.01675;
    znl = 1.5835218e-4;
    zel = 0.05490;

    /* --------------- calculate time varying periodics ----------- */
    zm = zmos + zns * t;
    // be sure that the initial call has time set to zero
    if (init == 'y')
        zm = zmos;
    zf = zm + 2.0 * zes * sin(zm);
    sinzf = sin(zf);
    f2 = 0.5 * sinzf * sinzf - 0.25;
    f3 = -0.5 * sinzf * cos(zf);
    ses = se2* f2 + se3 * f3;
    sis = si2 * f2 + si3 * f3;
    sls = sl2 * f2 + sl3 * f3 + sl4 * sinzf;
    sghs = sgh2 * f2 + sgh3 * f3 + sgh4 * sinzf;
    shs = sh2 * f2 + sh3 * f3;
    zm = zmol + znl * t;
    if (init == 'y')
        zm = zmol;
    zf = zm + 2.0 * zel * sin(zm);
    sinzf = sin(zf);
    f2 = 0.5 * sinzf * sinzf - 0.25;
    f3 = -0.5 * sinzf * cos(zf);
    sel = ee2 * f2 + e3 * f3;
    sil = xi2 * f2 + xi3 * f3;
    sll = xl2 * f2 + xl3 * f3 + xl4 * sinzf;
    sghl = xgh2 * f2 + xgh3 * f3 + xgh4 * sinzf;
    shll = xh2 * f2 + xh3 * f3;
    pe = ses + sel;
    pinc = sis + sil;
    pl = sls + sll;
    pgh = sghs + sghl;
    ph = shs + shll;

    if (init == 'n')
    {
        pe = pe - peo;
        pinc = pinc - pinco;
        pl = pl - plo;
        pgh = pgh - pgho;
        ph = ph - pho;
        inclp = inclp + pinc;
        ep = ep + pe;
        sinip = sin(inclp);
        cosip = cos(inclp);

        /* ----------------- apply periodics directly ------------ */
        //  sgp4fix for lyddane choice
        //  strn3 used original inclination - this is technically feasible
        //  gsfc used perturbed inclination - also technically feasible
        //  probably best to readjust the 0.2 limit value and limit discontinuity
        //  0.2 rad = 11.45916 deg
        //  use next line for original strn3 approach and original inclination
        //  if (inclo >= 0.2)
        //  use next line for gsfc version and perturbed inclination
        if (inclp >= 0.2)
        {
            ph = ph / sinip;
            pgh = pgh - cosip * ph;
            argpp = argpp + pgh;
            nodep = nodep + ph;
            mp = mp + pl;
        }
        else
        {
            /* ---- apply periodics with lyddane modification ---- */
            sinop = sin(nodep);
            cosop = cos(nodep);
            alfdp = sinip * sinop;
            betdp = sinip * cosop;
            dalf = ph * cosop + pinc * cosip * sinop;
            dbet = -ph * sinop + pinc * cosip * cosop;
            alfdp = alfdp + dalf;
            betdp = betdp + dbet;
            nodep = mod(nodep, twopi);
            //  sgp4fix for afspc written intrinsic functions
            // nodep used without a trigonometric function ahead
            if ((nodep < 0.0) && (opsmode == 'a'))
                nodep = nodep + twopi;
            xls = mp + argpp + cosip * nodep;
            dls = pl + pgh - pinc * nodep * sinip;
            xls = xls + dls;
            xnoh = nodep;
            nodep = atan(alfdp, betdp);
            //  sgp4fix for afspc written intrinsic functions
            // nodep used without a trigonometric function ahead
            if ((nodep < 0.0) && (opsmode == 'a'))
                nodep = nodep + twopi;
            if (abs(xnoh - nodep) > pi)
                if (nodep < xnoh)
                    nodep = nodep + twopi;
                else
                    nodep = nodep - twopi;
            mp = mp + pl;
            argpp = xls - mp - cosip * nodep;
        }
    }   // if init == 'n'

    //#include "debug1.cpp"
}  // dpper



bool sgp4
    (
    inout elsetrec satrec, float tsince,
    float r[3], float v[3]
    )
{
    float am, axnl, aynl, betal, cosim, cnod,
        cos2u, coseo1, cosi, cosip, cosisq, cossu, cosu,
        delm, delomg, em, emsq, ecose, el2, eo1,
        ep, esine, argpm, argpp, argpdf, pl, mrt = 0.0,
        mvt, rdotl, rl, rvdot, rvdotl, sinim,
        sin2u, sineo1, sini, sinip, sinsu, sinu,
        snod, su, t2, t3, t4, tem5, temp,
        temp1, temp2, tempa, tempe, templ, u, ux,
        uy, uz, vx, vy, vz, inclm, mm,
        nm, nodem, xinc, xincp, xl, xlm, mp,
        xmdf, xmx, xmy, nodedf, xnode, nodep, tc, dndt,
        twopi, x2o3, vkmpersec, delmtemp;
    int ktr;

    /* ------------------ set mathematical constants --------------- */
    // sgp4fix divisor for divide by zero check on inclination
    // the old check used 1.0 + cos(pi-1.0e-9), but then compared it to
    // 1.5 e-12, so the threshold was changed to 1.5e-12 for consistency
    const float temp4 = 1.5e-12;
    twopi = 2.0 * pi;
    x2o3 = 2.0 / 3.0;
    // sgp4fix identify constants and allow alternate values
    // getgravconst( whichconst, tumin, mu, radiusearthkm, xke, j2, j3, j4, j3oj2 );
    vkmpersec = satrec.radiusearthkm * satrec.xke / 60.0;

    /* --------------------- clear sgp4 error flag ----------------- */
    satrec.t = tsince;
    satrec.error = 0;

    /* ------- update for secular gravity and atmospheric drag ----- */
    xmdf = satrec.mo + satrec.mdot * satrec.t;
    argpdf = satrec.argpo + satrec.argpdot * satrec.t;
    nodedf = satrec.nodeo + satrec.nodedot * satrec.t;
    argpm = argpdf;
    mm = xmdf;
    t2 = satrec.t * satrec.t;
    nodem = nodedf + satrec.nodecf * t2;
    tempa = 1.0 - satrec.cc1 * satrec.t;
    tempe = satrec.bstar * satrec.cc4 * satrec.t;
    templ = satrec.t2cof * t2;

    if (satrec.isimp != 1)
    {
        delomg = satrec.omgcof * satrec.t;
        // sgp4fix use mutliply for speed instead of pow
        delmtemp = 1.0 + satrec.eta * cos(xmdf);
        delm = satrec.xmcof *
            (delmtemp * delmtemp * delmtemp -
            satrec.delmo);
        temp = delomg + delm;
        mm = xmdf + temp;
        argpm = argpdf - temp;
        t3 = t2 * satrec.t;
        t4 = t3 * satrec.t;
        tempa = tempa - satrec.d2 * t2 - satrec.d3 * t3 -
            satrec.d4 * t4;
        tempe = tempe + satrec.bstar * satrec.cc5 * (sin(mm) -
            satrec.sinmao);
        templ = templ + satrec.t3cof * t3 + t4 * (satrec.t4cof +
            satrec.t * satrec.t5cof);
    }

    nm = satrec.no_unkozai;
    em = satrec.ecco;
    inclm = satrec.inclo;
    if (satrec.method == 'd')
    {
        tc = satrec.t;
        dspace
            (
            satrec.irez,
            satrec.d2201, satrec.d2211, satrec.d3210,
            satrec.d3222, satrec.d4410, satrec.d4422,
            satrec.d5220, satrec.d5232, satrec.d5421,
            satrec.d5433, satrec.dedt, satrec.del1,
            satrec.del2, satrec.del3, satrec.didt,
            satrec.dmdt, satrec.dnodt, satrec.domdt,
            satrec.argpo, satrec.argpdot, satrec.t, tc,
            satrec.gsto, satrec.xfact, satrec.xlamo,
            satrec.no_unkozai, satrec.atime,
            em, argpm, inclm, satrec.xli, mm, satrec.xni,
            nodem, dndt, nm
            );
    } // if method = d

    if (nm <= 0.0)
    {
        //         printf("# error nm %f\n", nm);
        satrec.error = 2;
        // sgp4fix add return
        return false;
    }
    am = pow((satrec.xke / nm), x2o3) * tempa * tempa;
    nm = satrec.xke / pow(am, 1.5);
    em = em - tempe;

    // fix tolerance for error recognition
    // sgp4fix am is fixed from the previous nm check
    if ((em >= 1.0) || (em < -0.001)/* || (am < 0.95)*/)
    {
        //         printf("# error em %f\n", em);
        satrec.error = 1;
        // sgp4fix to return if there is an error in eccentricity
        return false;
    }
    // sgp4fix fix tolerance to avoid a divide by zero
    if (em < 1.0e-6)
        em = 1.0e-6;
    mm = mm + satrec.no_unkozai * templ;
    xlm = mm + argpm + nodem;
    emsq = em * em;
    temp = 1.0 - emsq;

    nodem = mod(nodem, twopi);
    argpm = mod(argpm, twopi);
    xlm = mod(xlm, twopi);
    mm = mod(xlm - argpm - nodem, twopi);

    // sgp4fix recover singly averaged mean elements
    satrec.am = am;
    satrec.em = em;
    satrec.im = inclm;
    satrec.Om = nodem;
    satrec.om = argpm;
    satrec.mm = mm;
    satrec.nm = nm;

    /* ----------------- compute extra mean quantities ------------- */
    sinim = sin(inclm);
    cosim = cos(inclm);

    /* -------------------- add lunar-solar periodics -------------- */
    ep = em;
    xincp = inclm;
    argpp = argpm;
    nodep = nodem;
    mp = mm;
    sinip = sinim;
    cosip = cosim;
    if (satrec.method == 'd')
    {
        dpper
            (
            satrec.e3, satrec.ee2, satrec.peo,
            satrec.pgho, satrec.pho, satrec.pinco,
            satrec.plo, satrec.se2, satrec.se3,
            satrec.sgh2, satrec.sgh3, satrec.sgh4,
            satrec.sh2, satrec.sh3, satrec.si2,
            satrec.si3, satrec.sl2, satrec.sl3,
            satrec.sl4, satrec.t, satrec.xgh2,
            satrec.xgh3, satrec.xgh4, satrec.xh2,
            satrec.xh3, satrec.xi2, satrec.xi3,
            satrec.xl2, satrec.xl3, satrec.xl4,
            satrec.zmol, satrec.zmos, satrec.inclo,
            'n', ep, xincp, nodep, argpp, mp, satrec.operationmode
            );
        if (xincp < 0.0)
        {
            xincp = -xincp;
            nodep = nodep + pi;
            argpp = argpp - pi;
        }
        if ((ep < 0.0) || (ep > 1.0))
        {
            //            printf("# error ep %f\n", ep);
            satrec.error = 3;
            // sgp4fix add return
            return false;
        }
    } // if method = d

    /* -------------------- long period periodics ------------------ */
    if (satrec.method == 'd')
    {
        sinip = sin(xincp);
        cosip = cos(xincp);
        satrec.aycof = -0.5*satrec.j3oj2*sinip;
        // sgp4fix for divide by zero for xincp = 180 deg
        if (abs(cosip + 1.0) > 1.5e-12)
            satrec.xlcof = -0.25 * satrec.j3oj2 * sinip * (3.0 + 5.0 * cosip) / (1.0 + cosip);
        else
            satrec.xlcof = -0.25 * satrec.j3oj2 * sinip * (3.0 + 5.0 * cosip) / temp4;
    }
    axnl = ep * cos(argpp);
    temp = 1.0 / (am * (1.0 - ep * ep));
    aynl = ep* sin(argpp) + temp * satrec.aycof;
    xl = mp + argpp + nodep + temp * satrec.xlcof * axnl;

    /* --------------------- solve kepler's equation --------------- */
    u = mod(xl - nodep, twopi);
    eo1 = u;
    tem5 = 9999.9;
    ktr = 1;
    //   sgp4fix for kepler iteration
    //   the following iteration needs better limits on corrections
    while ((abs(tem5) >= 1.0e-12) && (ktr <= 10))
    {
        sineo1 = sin(eo1);
        coseo1 = cos(eo1);
        tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
        tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
        if (abs(tem5) >= 0.95)
            tem5 = tem5 > 0.0 ? 0.95 : -0.95;
        eo1 = eo1 + tem5;
        ktr = ktr + 1;
    }

    /* ------------- short period preliminary quantities ----------- */
    ecose = axnl*coseo1 + aynl*sineo1;
    esine = axnl*sineo1 - aynl*coseo1;
    el2 = axnl*axnl + aynl*aynl;
    pl = am*(1.0 - el2);
    if (pl < 0.0)
    {
        //         printf("# error pl %f\n", pl);
        satrec.error = 4;
        // sgp4fix add return
        return false;
    }
    else
    {
        rl = am * (1.0 - ecose);
        rdotl = sqrt(am) * esine / rl;
        rvdotl = sqrt(pl) / rl;
        betal = sqrt(1.0 - el2);
        temp = esine / (1.0 + betal);
        sinu = am / rl * (sineo1 - aynl - axnl * temp);
        cosu = am / rl * (coseo1 - axnl + aynl * temp);
        su = atan(sinu, cosu);
        sin2u = (cosu + cosu) * sinu;
        cos2u = 1.0 - 2.0 * sinu * sinu;
        temp = 1.0 / pl;
        temp1 = 0.5 * satrec.j2 * temp;
        temp2 = temp1 * temp;

        /* -------------- update for short period periodics ------------ */
        if (satrec.method == 'd')
        {
            cosisq = cosip * cosip;
            satrec.con41 = 3.0*cosisq - 1.0;
            satrec.x1mth2 = 1.0 - cosisq;
            satrec.x7thm1 = 7.0*cosisq - 1.0;
        }
        mrt = rl * (1.0 - 1.5 * temp2 * betal * satrec.con41) +
            0.5 * temp1 * satrec.x1mth2 * cos2u;
        su = su - 0.25 * temp2 * satrec.x7thm1 * sin2u;
        xnode = nodep + 1.5 * temp2 * cosip * sin2u;
        xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
        mvt = rdotl - nm * temp1 * satrec.x1mth2 * sin2u / satrec.xke;
        rvdot = rvdotl + nm * temp1 * (satrec.x1mth2 * cos2u +
            1.5 * satrec.con41) / satrec.xke;

        /* --------------------- orientation vectors ------------------- */
        sinsu = sin(su);
        cossu = cos(su);
        snod = sin(xnode);
        cnod = cos(xnode);
        sini = sin(xinc);
        cosi = cos(xinc);
        xmx = -snod * cosi;
        xmy = cnod * cosi;
        ux = xmx * sinsu + cnod * cossu;
        uy = xmy * sinsu + snod * cossu;
        uz = sini * sinsu;
        vx = xmx * cossu - cnod * sinsu;
        vy = xmy * cossu - snod * sinsu;
        vz = sini * cossu;

        /* --------- position and velocity (in km and km/sec) ---------- */
        r[0] = (mrt * ux)* satrec.radiusearthkm;
        r[1] = (mrt * uy)* satrec.radiusearthkm;
        r[2] = (mrt * uz)* satrec.radiusearthkm;
        v[0] = (mvt * ux + rvdot * vx) * vkmpersec;
        v[1] = (mvt * uy + rvdot * vy) * vkmpersec;
        v[2] = (mvt * uz + rvdot * vz) * vkmpersec;
    }  // if pl > 0

    // sgp4fix for decaying satellites
    if (mrt < 1.0)
    {
        //         printf("# decay condition %11.6f \n",mrt);
        satrec.error = 6;
        return false;
    }

    //#include "debug7.cpp"
    return true;
}  // sgp4



void main() {

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // scale the vertices based on depth, base size 50 units
    float size = 50.0 / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = size;
}